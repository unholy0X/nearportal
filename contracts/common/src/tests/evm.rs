use crate::evm::*;

// Generated independently with viem `serializeTransaction` and the ERC-20 ABI: transfer of
// 1,000,000 units (1 USDC) to 0x1111...1111, max fee 1 gwei, priority fee 0.001 gwei.
const GOLDEN_UNSIGNED: &str = "0x02f86f83014a3480830f4240843b9aca008301d4c094036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240c0";
const GOLDEN_DIGEST: &str = "9dc5186e4ae26d33995e33068837606d6ace1391ac94a7d55a0cc36011938ee2";
// viem `signTransaction` of GOLDEN_UNSIGNED with the test key [7u8; 32], then keccak256.
const GOLDEN_SIGNATURE: &str = "0xd5cc1b30283ac093d686ebf8b7ed7d0a0b4ca2c7d099d455b56aa04c8ee7431a5281374041f2b67b7eeb8d16fe5440561e68047da33e2a6bcdac10c9f89624841c";
const GOLDEN_TX_HASH: &str = "83d8f40bf0905fd66cf7d73c31fdc99424cbb7b3baf637774807764d4cc29d3d";

#[test]
fn eip191_matches_viem_hash_message() {
    assert_eq!(
        hex::encode(eip191_hash("I hereby declare that I am the address owner.")),
        "b77c35c892a1b24b10a2ce49b424e578472333ee8d2456234fff90626332c50f"
    );
    assert_eq!(
        hex::encode(eip191_hash(
            "Send EUR 720 to FR76...0189 at 2026-10-20T14:16:08Z"
        )),
        "9249f5080df9823d59aec8a044403df91efce4d219000f9d5e038e656f6e0d06"
    );
}

#[test]
fn validates_evm_addresses() {
    assert!(is_evm_address("0x91c098fc987eec6c82d3fb202044f1d0399ba9e7"));
    assert!(!is_evm_address(
        "0x91C098FC987EEC6C82D3FB202044F1D0399BA9E7"
    ));
    assert!(!is_evm_address("91c098fc987eec6c82d3fb202044f1d0399ba9e7"));
    assert!(!is_evm_address(
        "0x0000000000000000000000000000000000000000"
    ));
    assert!(is_evm_address(USDC_TOKEN));
}

#[test]
fn golden_transfer_pins_token_chain_nonce_recipient_and_amount() {
    let tx = erc20_transfer_eip1559(
        "0x1111111111111111111111111111111111111111",
        100 * USDC_UNITS_PER_CENT,
        1_000_000_000,
        1_000_000,
    );
    assert_eq!(format!("0x{}", hex::encode(&tx)), GOLDEN_UNSIGNED);
    assert_eq!(
        hex::encode(near_sdk::env::keccak256_array(&tx)),
        GOLDEN_DIGEST
    );
    // Circle's published Base Sepolia USDC address, independent from the constant.
    assert!(GOLDEN_UNSIGNED.contains("94036cbd53842c5426634e7929541ec2318f3dcf7e"));
}

#[test]
fn signed_transaction_hash_matches_viem() {
    let tx = hex::decode(&GOLDEN_UNSIGNED[2..]).unwrap();
    let hash = signed_transaction_hash(&tx, GOLDEN_SIGNATURE).unwrap();
    assert_eq!(hex::encode(hash), GOLDEN_TX_HASH);
}

#[test]
fn signed_transaction_hash_rejects_malformed_input() {
    let tx = hex::decode(&GOLDEN_UNSIGNED[2..]).unwrap();
    assert!(signed_transaction_hash(&tx, "0x1234").is_none());
    assert!(signed_transaction_hash(&tx[..tx.len() - 1], GOLDEN_SIGNATURE).is_none());
    let mut legacy = tx.clone();
    legacy[0] = 0x01;
    assert!(signed_transaction_hash(&legacy, GOLDEN_SIGNATURE).is_none());
}
