use super::*;
use crate::payout::SIGNATURE_RETRY_SECS;

const RETRY_AT: u64 = T0 + 4 * SEC + (SIGNATURE_RETRY_SECS + 1) * SEC;

fn signed(c: &mut Contract, attempt: u32, at: u64) {
    let digest = payout(c).digest;
    result(at, PromiseResult::Successful(signature_response(&digest)));
    c.on_payout_signed(ID.into(), attempt);
}

#[test]
fn valid_signature_verified_processed_idempotent() {
    let mut c = submitted(None);
    settle(&mut c);
    signed(&mut c, 0, T0 + 5 * SEC);
    let p = payout(&c);
    assert!(p.signature.is_some() && !p.signing);
    set("relayer.testnet", T0 + 6 * SEC);
    c.mark_payout_processed(ID.into(), GOLDEN_TX_HASH.into());
    c.mark_payout_processed(ID.into(), GOLDEN_TX_HASH.into());
    assert_eq!(payout(&c).tx_hash.as_deref(), Some(GOLDEN_TX_HASH));
}

#[test]
#[should_panic(expected = "Invalid processed receipt")]
fn processed_hash_must_match_the_signed_transaction() {
    let mut c = submitted(None);
    settle(&mut c);
    signed(&mut c, 0, T0 + 5 * SEC);
    set("relayer.testnet", T0 + 6 * SEC);
    c.mark_payout_processed(ID.into(), format!("0x{}", "e".repeat(64)));
}

#[test]
#[should_panic(expected = "Payout is not signed")]
fn unsigned_payout_cannot_be_processed() {
    let mut c = submitted(None);
    settle(&mut c);
    set("relayer.testnet", T0 + 5 * SEC);
    c.mark_payout_processed(ID.into(), GOLDEN_TX_HASH.into());
}

#[test]
#[should_panic(expected = "Only the relayer")]
fn only_relayer_marks_processed() {
    let mut c = submitted(None);
    settle(&mut c);
    signed(&mut c, 0, T0 + 5 * SEC);
    set("verifier.testnet", T0 + 6 * SEC);
    c.mark_payout_processed(ID.into(), GOLDEN_TX_HASH.into());
}

#[test]
fn signature_from_another_key_is_rejected() {
    let mut c = submitted(None);
    settle(&mut c);
    let foreign = br#"{"big_r":{"affine_point":"02cf5f699d87be63f275eef2286352cff0e28c1f68865179c1772d72a846fa19d6"},"recovery_id":1,"s":{"scalar":"758b7763d224bb9ff47fab658f898980ea8257d9f09725cf7b26c69941a52f83"}}"#;
    result(T0 + 5 * SEC, PromiseResult::Successful(foreign.to_vec()));
    c.on_payout_signed(ID.into(), 0);
    let p = payout(&c);
    assert!(p.signature.is_none() && !p.signing);
}

#[test]
fn signature_retry_freezes_payload() {
    let mut c = submitted(None);
    settle(&mut c);
    let first = payout(&c);
    result(T0 + 5 * SEC, PromiseResult::Failed);
    c.on_payout_signed(ID.into(), 0);
    set("verifier.testnet", RETRY_AT);
    c.retry_payout_signature(ID.into());
    let retry = payout(&c);
    assert_eq!(retry.attempt, 1);
    assert_eq!(retry.unsigned_tx, first.unsigned_tx);
    assert_eq!(retry.digest, first.digest);
    // A late callback of attempt 0 is ignored.
    signed(&mut c, 0, RETRY_AT + SEC);
    assert!(payout(&c).signature.is_none());
    signed(&mut c, 1, RETRY_AT + 2 * SEC);
    assert!(payout(&c).signature.is_some());
}

#[test]
#[should_panic(expected = "Signature retry not ready")]
fn signature_retry_cannot_race_callback() {
    let mut c = submitted(None);
    settle(&mut c);
    set("verifier.testnet", RETRY_AT - SEC);
    c.retry_payout_signature(ID.into());
}

#[test]
#[should_panic(expected = "Signature retry not ready")]
fn signed_payout_is_not_signed_again() {
    let mut c = submitted(None);
    settle(&mut c);
    signed(&mut c, 0, T0 + 5 * SEC);
    set("verifier.testnet", RETRY_AT);
    c.retry_payout_signature(ID.into());
}

#[test]
fn owner_can_retry_a_lost_signature_while_paused() {
    let mut c = submitted(None);
    settle(&mut c);
    set("owner.testnet", T0 + 5 * SEC);
    c.set_paused(true);
    set("owner.testnet", RETRY_AT);
    c.retry_payout_signature(ID.into());
    assert_eq!(payout(&c).attempt, 1);
}

#[test]
#[should_panic(expected = "Only the verifier or the owner")]
fn third_party_cannot_retry_signature() {
    let mut c = submitted(None);
    settle(&mut c);
    set("client.testnet", RETRY_AT);
    c.retry_payout_signature(ID.into());
}
