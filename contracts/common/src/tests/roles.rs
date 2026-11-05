use super::{acc, set, T0};
use crate::events::Rail;
use crate::roles::*;

fn roles() -> Roles {
    set("owner.testnet", T0);
    Roles::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("verifier.testnet"),
        b"t".to_vec(),
    )
}

#[test]
#[should_panic(expected = "Verifier must be independent")]
fn owner_cannot_be_the_verifier() {
    set("owner.testnet", T0);
    Roles::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("owner.testnet"),
        b"t".to_vec(),
    );
}

#[test]
#[should_panic(expected = "Operator must be independent")]
fn verifier_cannot_be_an_operator() {
    let mut r = roles();
    r.set_operator(Rail::Bank, acc("verifier.testnet"), true);
}

#[test]
#[should_panic(expected = "Verifier must be independent")]
fn operator_cannot_become_the_verifier() {
    let mut r = roles();
    r.set_operator(Rail::Bank, acc("client.testnet"), true);
    r.set_verifier(Rail::Bank, acc("client.testnet"));
}

#[test]
#[should_panic(expected = "Owner must be independent")]
fn ownership_cannot_go_to_the_verifier() {
    let mut r = roles();
    r.transfer_ownership(Rail::Bank, acc("verifier.testnet"));
}

#[test]
fn operators_can_be_added_and_removed() {
    let mut r = roles();
    r.set_operator(Rail::Bank, acc("client.testnet"), true);
    assert_eq!(r.operator_list(), vec![acc("client.testnet")]);
    r.set_operator(Rail::Bank, acc("client.testnet"), false);
    assert!(r.operator_list().is_empty());
}
