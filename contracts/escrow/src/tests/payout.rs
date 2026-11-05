use super::*;
use nearportal_common::monerium::{MESSAGE_LEAD_SECS, MONERIUM_TOLERANCE_SECS};
use nearportal_common::mpc::MPC_TIMEOUT_SECS;

const EXPIRED: u64 = (MESSAGE_LEAD_SECS + MONERIUM_TOLERANCE_SECS + 1) * SEC;

#[test]
fn payout_message_and_digest_follow_monerium() {
    let (c, _, p, _) = refund_payout();
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.state, PayoutState::Signing);
    // Scheduled at T0 + 2 s; the message timestamp leads by 10 minutes.
    assert_eq!(
        payout.message,
        "Send EUR 720 to FR14...6789 at 2026-10-20T14:26:10Z"
    );
    assert_eq!(
        payout.payload_hash,
        hex::encode(nearportal_common::evm::eip191_hash(&payout.message))
    );
}

#[test]
fn verified_signature_is_stored_and_processed() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.state, PayoutState::Signed);
    let digest: [u8; 32] = hex::decode(&payout.payload_hash)
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        nearportal_common::mpc::recover_evm_address(&digest, payout.signature.as_ref().unwrap()),
        Some(escrow_address())
    );
    set("relayer.testnet", t);
    c.mark_payout_processed(p, "order-out-1".into());
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Processed);
}

#[test]
fn unparsable_response_fails_without_panicking() {
    let (mut c, _, p, t) = refund_payout();
    callback(
        &mut c,
        p,
        t,
        PromiseResult::Successful(b"{\"unexpected\":true}".to_vec()),
    );
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.state, PayoutState::SignFailed);
    assert_eq!(
        payout.failure_reason.as_deref(),
        Some("unparsable response")
    );
}

#[test]
fn failed_promise_marks_sign_failed() {
    let (mut c, _, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Failed);
    assert_eq!(
        c.get_payout(p).unwrap().failure_reason.as_deref(),
        Some("mpc call failed")
    );
}

#[test]
fn signature_from_another_key_is_rejected() {
    let (mut c, _, p, t) = refund_payout();
    // Valid MPC signature from the Monerium sandbox run, but over another digest and address.
    let foreign = br#"{"big_r":{"affine_point":"02cf5f699d87be63f275eef2286352cff0e28c1f68865179c1772d72a846fa19d6"},"recovery_id":1,"s":{"scalar":"758b7763d224bb9ff47fab658f898980ea8257d9f09725cf7b26c69941a52f83"}}"#;
    callback(&mut c, p, t, PromiseResult::Successful(foreign.to_vec()));
    assert_eq!(
        c.get_payout(p).unwrap().failure_reason.as_deref(),
        Some("signer mismatch")
    );
}

#[test]
fn late_or_duplicate_callback_is_ignored() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    let sig = c.get_payout(p).unwrap().signature;
    callback(&mut c, p, t, PromiseResult::Failed);
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.state, PayoutState::Signed);
    assert_eq!(payout.signature, sig);
}

#[test]
#[should_panic(expected = "Previous message has not expired yet")]
fn sign_failed_retry_waits_for_expiry() {
    let (mut c, _, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Failed);
    set("client.testnet", t + 60 * SEC);
    let _ = c.retry_payout(p);
}

#[test]
fn sign_failed_retry_after_expiry_keeps_amount_and_commitment() {
    let (mut c, id, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Failed);
    set("client.testnet", t + EXPIRED);
    let _ = c.retry_payout(p);
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.state, PayoutState::Signing);
    assert_eq!(payout.attempt, 1);
    assert_eq!(payout.amount_cents, U64(REWARD));
    assert_eq!(payout.short_iban, REFUND_IBAN);
    assert_eq!(c.get_bounty(id).unwrap().committed_cents, U64(REWARD));
}

#[test]
#[should_panic(expected = "Payout cannot be signed again")]
fn signed_payout_cannot_be_resigned_without_owner() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    set("relayer.testnet", t + 3600 * SEC);
    let _ = c.retry_payout(p);
}

#[test]
fn owner_can_authorize_resign_after_expiry() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    let later = t + 3600 * SEC;
    set("owner.testnet", later);
    c.authorize_resign(p);
    set("relayer.testnet", later);
    let _ = c.retry_payout(p);
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Signing);
}

#[test]
#[should_panic(expected = "Message has not expired yet")]
fn authorize_resign_before_expiry_is_refused() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    set("owner.testnet", t);
    c.authorize_resign(p);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_authorizes_resign() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    set("client.testnet", t + 3600 * SEC);
    c.authorize_resign(p);
}

#[test]
fn stuck_signing_payout_needs_the_owner_twice() {
    let (mut c, _, p, t) = refund_payout();
    let later = t + (MESSAGE_LEAD_SECS + MONERIUM_TOLERANCE_SECS + MPC_TIMEOUT_SECS + 1) * SEC;
    set("owner.testnet", later);
    c.mark_sign_failed(p);
    assert_eq!(
        c.get_payout(p).unwrap().failure_reason.as_deref(),
        Some("timeout")
    );
    c.authorize_resign(p);
    set("client.testnet", later);
    let _ = c.retry_payout(p);
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Signing);
}

#[test]
#[should_panic(expected = "Signing has not timed out yet")]
fn stuck_signing_needs_the_timeout() {
    let (mut c, _, p, t) = refund_payout();
    set("owner.testnet", t + 60 * SEC);
    c.mark_sign_failed(p);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn non_owner_cannot_mark_sign_failed() {
    let (mut c, _, p, t) = refund_payout();
    set("relayer.testnet", t + 3600 * SEC);
    c.mark_sign_failed(p);
}

#[test]
#[should_panic(expected = "Payout cannot be signed again")]
fn processed_payout_cannot_be_retried() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    set("relayer.testnet", t);
    c.mark_payout_processed(p, "order-out-1".into());
    set("relayer.testnet", t + 3600 * SEC);
    let _ = c.retry_payout(p);
}

#[test]
#[should_panic(expected = "Only the client, the owner or the relayer")]
fn third_party_cannot_retry_payout() {
    let (mut c, _, p, t) = refund_payout();
    set("stranger.testnet", t + 3600 * SEC);
    let _ = c.retry_payout(p);
}

#[test]
#[should_panic(expected = "Only the relayer")]
fn only_relayer_marks_processed() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    set("client.testnet", t);
    c.mark_payout_processed(p, "x".into());
}

#[test]
#[should_panic(expected = "Payout is not signed")]
fn cannot_mark_unsigned_payout_processed() {
    let (mut c, _, p, t) = refund_payout();
    set("relayer.testnet", t);
    c.mark_payout_processed(p, "x".into());
}

#[test]
fn stale_callback_from_previous_attempt_is_ignored() {
    let (mut c, _, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Failed);
    set("client.testnet", t + EXPIRED);
    let _ = c.retry_payout(p);
    assert_eq!(c.get_payout(p).unwrap().attempt, 1);
    with_result(t + EXPIRED, PromiseResult::Failed);
    c.on_payout_signed(p, 0);
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Signing);
}

#[test]
#[should_panic(expected = "Payout cannot be signed again")]
fn unverified_failure_needs_the_owner_before_retry() {
    let (mut c, _, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Successful(b"{}".to_vec()));
    set("client.testnet", t + 3600 * SEC);
    let _ = c.retry_payout(p);
}

#[test]
fn authorized_resign_can_only_be_used_once() {
    let (mut c, _, p, t) = refund_payout();
    sign_ok(&mut c, p, t);
    let later = t + 3600 * SEC;
    set("owner.testnet", later);
    c.authorize_resign(p);
    let _ = c.retry_payout(p);
    assert!(!c.get_payout(p).unwrap().resign_authorized);
}

#[test]
fn processing_closes_open_payouts() {
    let (mut c, id, p, t) = refund_payout();
    assert_eq!(c.get_bounty(id).unwrap().open_payouts, 1);
    sign_ok(&mut c, p, t);
    set("relayer.testnet", t);
    c.mark_payout_processed(p, "order-out-1".into());
    assert_eq!(c.get_bounty(id).unwrap().open_payouts, 0);
}

#[test]
fn pause_never_blocks_payout_recovery() {
    let (mut c, _, p, t) = refund_payout();
    callback(&mut c, p, t, PromiseResult::Failed);
    set("owner.testnet", t);
    c.set_paused(true);
    set("relayer.testnet", t + EXPIRED);
    let _ = c.retry_payout(p);
    sign_ok(&mut c, p, t + EXPIRED);
    set("relayer.testnet", t + EXPIRED);
    c.mark_payout_processed(p, "order-out-1".into());
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Processed);
}
