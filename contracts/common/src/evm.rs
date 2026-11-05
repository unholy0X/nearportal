//! EVM message and transaction building for both rails: EIP-191 digests (bank rail, Monerium)
//! and the single EIP-1559 ERC-20 transfer the USDC rail may sign.

use near_sdk::env;

use crate::util::is_lower_hex;

/// Base Sepolia. Compile-time constant: this build cannot target another chain.
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84_532;
/// Circle's Base Sepolia test USDC (6 decimals).
pub const USDC_TOKEN: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/// 1 cent = 10,000 USDC base units.
pub const USDC_UNITS_PER_CENT: u64 = 10_000;
pub const TRANSFER_GAS_LIMIT: u64 = 120_000;
/// Upper bound on `max_fee_per_gas`, in wei (100 gwei).
pub const MAX_FEE_PER_GAS_WEI: u64 = 100_000_000_000;
/// The only nonce an escrow address ever signs: one outgoing transaction per bounty.
pub const ESCROW_NONCE: u64 = 0;

/// EIP-191 (`personal_sign`) digest: keccak256("\x19Ethereum Signed Message:\n" + len + message).
pub fn eip191_hash(message: &str) -> [u8; 32] {
    let mut data = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    data.extend_from_slice(message.as_bytes());
    env::keccak256_array(&data)
}

/// `0x` + 40 lowercase hex characters, not the zero address.
pub fn is_evm_address(address: &str) -> bool {
    address.len() == 42
        && address.starts_with("0x")
        && is_lower_hex(&address[2..])
        && address[2..].bytes().any(|c| c != b'0')
}

fn rlp_length(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![offset + len as u8];
    }
    let be = (len as u64).to_be_bytes();
    let first = be.iter().position(|b| *b != 0).unwrap_or(7);
    let mut out = vec![offset + 55 + (8 - first) as u8];
    out.extend_from_slice(&be[first..]);
    out
}

fn rlp_bytes(v: &[u8]) -> Vec<u8> {
    if v.len() == 1 && v[0] < 0x80 {
        return v.to_vec();
    }
    let mut out = rlp_length(v.len(), 0x80);
    out.extend_from_slice(v);
    out
}

/// Big-endian integer without leading zero bytes.
fn rlp_scalar(be: &[u8]) -> Vec<u8> {
    let first = be.iter().position(|b| *b != 0).unwrap_or(be.len());
    rlp_bytes(&be[first..])
}

fn rlp_uint(v: u64) -> Vec<u8> {
    rlp_scalar(&v.to_be_bytes())
}

fn typed_list(fields: &[u8]) -> Vec<u8> {
    let mut out = vec![0x02];
    out.extend(rlp_length(fields.len(), 0xc0));
    out.extend_from_slice(fields);
    out
}

/// Unsigned EIP-1559 transaction calling `USDC_TOKEN.transfer(recipient, units)` at nonce 0.
/// `recipient` must satisfy `is_evm_address`.
pub fn erc20_transfer_eip1559(
    recipient: &str,
    units: u64,
    max_fee_per_gas: u64,
    max_priority_fee_per_gas: u64,
) -> Vec<u8> {
    let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
    data.extend([0u8; 12]);
    data.extend(hex::decode(&recipient[2..]).unwrap_or_default());
    data.extend([0u8; 24]);
    data.extend(units.to_be_bytes());
    let mut fields = Vec::new();
    for v in [
        BASE_SEPOLIA_CHAIN_ID,
        ESCROW_NONCE,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        TRANSFER_GAS_LIMIT,
    ] {
        fields.extend(rlp_uint(v));
    }
    fields.extend(rlp_bytes(
        &hex::decode(&USDC_TOKEN[2..]).unwrap_or_default(),
    ));
    fields.extend(rlp_uint(0));
    fields.extend(rlp_bytes(&data));
    fields.push(0xc0);
    typed_list(&fields)
}

/// Fields of a typed (`0x02`) transaction envelope, without the list header.
fn typed_fields(tx: &[u8]) -> Option<&[u8]> {
    let (&kind, rest) = tx.split_first()?;
    let (&header, rest) = rest.split_first()?;
    if kind != 0x02 || header < 0xc0 {
        return None;
    }
    let (len, payload) = if header <= 0xf7 {
        (usize::from(header - 0xc0), rest)
    } else {
        let n = usize::from(header - 0xf7);
        if rest.len() < n || n > 8 {
            return None;
        }
        let len = rest[..n].iter().try_fold(0usize, |acc, b| {
            acc.checked_mul(256)?.checked_add(usize::from(*b))
        })?;
        (len, &rest[n..])
    };
    (payload.len() == len).then_some(payload)
}

/// Hash of the broadcast transaction: keccak256 of `unsigned` with the `0x{r}{s}{v}`
/// signature appended (yParity, r, s). `None` if either input is malformed.
pub fn signed_transaction_hash(unsigned: &[u8], signature: &str) -> Option<[u8; 32]> {
    let fields = typed_fields(unsigned)?;
    let sig = hex::decode(signature.strip_prefix("0x")?).ok()?;
    if sig.len() != 65 || !(27..=28).contains(&sig[64]) {
        return None;
    }
    let mut signed = fields.to_vec();
    signed.extend(rlp_uint(u64::from(sig[64] - 27)));
    signed.extend(rlp_scalar(&sig[..32]));
    signed.extend(rlp_scalar(&sig[32..64]));
    Some(env::keccak256_array(typed_list(&signed)))
}
