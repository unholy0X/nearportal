use crate::evm::eip191_hash;
use crate::mpc::*;

const SANDBOX_SIGNATURE: &str = "0xcf5f699d87be63f275eef2286352cff0e28c1f68865179c1772d72a846fa19d6758b7763d224bb9ff47fab658f898980ea8257d9f09725cf7b26c69941a52f831c";
const SANDBOX_ADDRESS: &str = "0x91c098fc987eec6c82d3fb202044f1d0399ba9e7";

#[test]
fn recovers_the_escrow_address_from_the_sandbox_signature() {
    // Produced by the NEAR MPC network for the project's first testnet account and path and
    // accepted by Monerium sandbox on 2026-10-20.
    let digest = eip191_hash(crate::monerium::OWNERSHIP_MESSAGE);
    assert_eq!(
        recover_evm_address(&digest, SANDBOX_SIGNATURE).as_deref(),
        Some(SANDBOX_ADDRESS)
    );
    let other = eip191_hash("Send EUR 720 to FR76...0189 at 2026-10-20T14:16:08Z");
    assert_ne!(
        recover_evm_address(&other, SANDBOX_SIGNATURE).as_deref(),
        Some(SANDBOX_ADDRESS)
    );
}

#[test]
fn derives_the_address_from_the_mpc_public_key() {
    // derived_public_key for the project's first testnet account and path.
    let key = "secp256k1:4u4UxRZMRVHdTHegL7JaJNG9zaWYogUo3wBZsRZ5BdXzjL2Lg3aZ3wvXNzuqdZGWzmbRMvgvsVZqH8YmQSsTPoJ3";
    assert_eq!(
        evm_address_from_mpc_key(key).as_deref(),
        Some(SANDBOX_ADDRESS)
    );
    assert!(evm_address_from_mpc_key("ed25519:abc").is_none());
    assert!(evm_address_from_mpc_key("secp256k1:2g").is_none());
}

#[test]
fn rejects_malformed_signatures() {
    let digest = [0u8; 32];
    assert!(recover_evm_address(&digest, "0x1234").is_none());
    assert!(recover_evm_address(&digest, "no-prefix").is_none());
}

#[test]
fn assembles_mpc_signature_like_the_sandbox_run() {
    // Values returned by v1.signer-prod.testnet on 2026-10-20 and accepted by Monerium.
    let sig = evm_signature(
        "02cf5f699d87be63f275eef2286352cff0e28c1f68865179c1772d72a846fa19d6",
        "758b7763d224bb9ff47fab658f898980ea8257d9f09725cf7b26c69941a52f83",
        1,
    )
    .unwrap();
    assert_eq!(sig, SANDBOX_SIGNATURE);
}

#[test]
fn rejects_malformed_mpc_responses() {
    let s = "758b7763d224bb9ff47fab658f898980ea8257d9f09725cf7b26c69941a52f83";
    assert!(evm_signature("04cf5f", s, 0).is_none());
    assert!(evm_signature("02zz", s, 0).is_none());
    assert!(evm_signature(
        "02cf5f699d87be63f275eef2286352cff0e28c1f68865179c1772d72a846fa19d6",
        s,
        2
    )
    .is_none());
}
