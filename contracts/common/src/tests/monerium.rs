use crate::monerium::*;

#[test]
fn formats_small_amounts_like_monerium() {
    assert_eq!(format_eur(1), "0.01");
    assert_eq!(format_eur(10), "0.10");
    assert_eq!(format_eur(100), "1");
}

#[test]
fn formats_euro_amounts() {
    assert_eq!(format_eur(72_000), "720");
    assert_eq!(format_eur(72_050), "720.50");
    assert_eq!(format_eur(72_005), "720.05");
    assert_eq!(format_eur(5), "0.05");
    assert_eq!(format_eur(0), "0");
}

#[test]
fn validates_short_ibans() {
    assert!(is_valid_short_iban("FR76...0189"));
    assert!(is_valid_short_iban("EE48...8955"));
    // Full form of the Monerium sandbox example IBAN. Use your own Monerium sandbox IBAN.
    assert!(!is_valid_short_iban("FR7630006000011234567890189"));
    assert!(!is_valid_short_iban("fr76...0189"));
    assert!(!is_valid_short_iban("FR76..0189"));
    assert!(!is_valid_short_iban("FR76...018"));
}

#[test]
fn formats_rfc3339_against_reference_values() {
    // Reference values computed with Python's datetime (UTC).
    assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339_utc(1_709_210_096), "2024-02-29T12:34:56Z");
    assert_eq!(rfc3339_utc(1_792_505_768), "2026-10-20T14:16:08Z");
    assert_eq!(rfc3339_utc(4_102_444_799), "2099-12-31T23:59:59Z");
}

#[test]
fn builds_the_message_monerium_accepted_in_sandbox() {
    // This exact message was accepted by Monerium sandbox on 2026-10-20.
    assert_eq!(
        redeem_message(72_000, "FR76...0189", 1_792_505_768),
        "Send EUR 720 to FR76...0189 at 2026-10-20T14:16:08Z"
    );
}
