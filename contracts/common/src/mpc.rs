//! NEAR Chain Signatures (MPC) requests and the checks applied to their responses.
//! Trust assumption: the MPC network signs only what this contract requests under its own
//! derivation paths; every returned signature is still verified with `ecrecover`.

use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

use crate::errors;
use crate::util::require_gas;

/// Static gas forwarded to the MPC `sign` call (validated on testnet, 2026-10-20).
pub const GAS_FOR_SIGN: Gas = Gas::from_tgas(50);
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
pub const GAS_FOR_DERIVE: Gas = Gas::from_tgas(10);
pub const GAS_MARGIN: Gas = Gas::from_tgas(5);
pub const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Upper bound on MPC response sizes read in callbacks.
pub const MAX_MPC_RESPONSE_LEN: usize = 1024;
/// Extra wait before a payout stuck in signing may be declared failed (MPC yield timeout margin).
pub const MPC_TIMEOUT_SECS: u64 = 5 * 60;

/// Callback failure reasons stored on payouts (not panics).
/// `REASON_MPC_FAILED` proves no signature was produced, so a retry needs no owner approval.
pub const REASON_MPC_FAILED: &str = "mpc call failed";
pub const REASON_UNPARSABLE: &str = "unparsable response";
pub const REASON_MALFORMED: &str = "malformed signature";
pub const REASON_SIGNER_MISMATCH: &str = "signer mismatch";
pub const REASON_INVALID_PAYLOAD: &str = "invalid payload hash";
pub const REASON_TIMEOUT: &str = "timeout";

/// Response of the MPC `sign` method (secp256k1 domain).
#[near(serializers = [json])]
pub struct SignResponse {
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

/// MPC response parts (`big_r` compressed point, `s`, `recovery_id`) as the 65-byte
/// `0x{r}{s}{v}` signature EVM tooling and Monerium expect.
pub fn evm_signature(big_r_compressed_hex: &str, s_hex: &str, recovery_id: u8) -> Option<String> {
    let r = big_r_compressed_hex
        .strip_prefix("02")
        .or_else(|| big_r_compressed_hex.strip_prefix("03"))?;
    let valid_hex = |x: &str| x.len() == 64 && x.bytes().all(|c| c.is_ascii_hexdigit());
    if !valid_hex(r) || !valid_hex(s_hex) || recovery_id > 1 {
        return None;
    }
    Some(format!(
        "0x{}{}{:02x}",
        r.to_ascii_lowercase(),
        s_hex.to_ascii_lowercase(),
        27 + recovery_id
    ))
}

/// Address that produced `0x{r}{s}{v}` over `digest`. Rejects high-s (malleable) signatures.
pub fn recover_evm_address(digest: &[u8; 32], signature: &str) -> Option<String> {
    let bytes = hex::decode(signature.strip_prefix("0x")?).ok()?;
    if bytes.len() != 65 || !(27..=28).contains(&bytes[64]) {
        return None;
    }
    let public_key = env::ecrecover(digest, &bytes[..64], bytes[64] - 27, true)?;
    let hash = env::keccak256_array(public_key);
    Some(format!("0x{}", hex::encode(&hash[12..])))
}

/// EVM address of an MPC `derived_public_key` result (`"secp256k1:<base58 of x||y>"`).
pub fn evm_address_from_mpc_key(key: &str) -> Option<String> {
    let raw = bs58::decode(key.strip_prefix("secp256k1:")?)
        .into_vec()
        .ok()?;
    if raw.len() != 64 {
        return None;
    }
    let hash = env::keccak256_array(&raw);
    Some(format!("0x{}", hex::encode(&hash[12..])))
}

/// Requires enough remaining gas for `count` more signature requests and their callbacks.
pub fn require_gas_for_signatures(count: u64) {
    let per = GAS_FOR_SIGN.as_gas() + GAS_FOR_CALLBACK.as_gas() + GAS_MARGIN.as_gas();
    require_gas(Gas::from_gas(per.saturating_mul(count)));
}

pub fn require_gas_for_derivation() {
    require_gas(Gas::from_gas(
        GAS_FOR_DERIVE.as_gas() + GAS_FOR_CALLBACK.as_gas() + GAS_MARGIN.as_gas(),
    ));
}

fn to_vec(args: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(args).unwrap_or_else(|_| env::panic_str(errors::SERIALIZATION))
}

/// `sign` request for `digest` under this contract's `path`. Chain a callback to it.
pub fn sign(mpc_contract: &AccountId, path: &str, digest: [u8; 32]) -> Promise {
    let args = json!({
        "request": { "path": path, "payload_v2": { "Ecdsa": hex::encode(digest) }, "domain_id": 0 }
    });
    Promise::new(mpc_contract.clone()).function_call(
        "sign".to_string(),
        to_vec(&args),
        MPC_SIGN_DEPOSIT,
        GAS_FOR_SIGN,
    )
}

/// `derived_public_key` request for this contract's `path`. Chain a callback to it.
pub fn derived_public_key(mpc_contract: &AccountId, path: &str) -> Promise {
    let args = json!({ "path": path, "predecessor": env::current_account_id(), "domain_id": 0 });
    Promise::new(mpc_contract.clone()).function_call(
        "derived_public_key".to_string(),
        to_vec(&args),
        NearToken::from_yoctonear(0),
        GAS_FOR_DERIVE,
    )
}

/// In a `derived_public_key` callback: the derived EVM address, if the call succeeded.
pub fn derived_address() -> Option<String> {
    env::promise_result_checked(0, MAX_MPC_RESPONSE_LEN)
        .ok()
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .and_then(|key| evm_address_from_mpc_key(&key))
}

/// In a `sign` callback: the `0x{r}{s}{v}` signature, only if it recovers to
/// `expected_address` over `digest`. Never panics.
pub fn verified_signature(
    digest: &[u8; 32],
    expected_address: &str,
) -> Result<String, &'static str> {
    let bytes =
        env::promise_result_checked(0, MAX_MPC_RESPONSE_LEN).map_err(|_| REASON_MPC_FAILED)?;
    let r = serde_json::from_slice::<SignResponse>(&bytes).map_err(|_| REASON_UNPARSABLE)?;
    let sig =
        evm_signature(&r.big_r.affine_point, &r.s.scalar, r.recovery_id).ok_or(REASON_MALFORMED)?;
    match recover_evm_address(digest, &sig) {
        Some(signer) if signer == expected_address => Ok(sig),
        _ => Err(REASON_SIGNER_MISMATCH),
    }
}
