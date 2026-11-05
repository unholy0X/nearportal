//! Monerium redeem and ownership messages. Monerium accepts a redeem order when the owner of
//! the EURe address signs `Send EUR <amount> to <IBAN first 4>...<IBAN last 4> at <RFC 3339 UTC>`
//! with EIP-191. The signed message commits only the short IBAN; the full IBAN is held off
//! chain by the relayer (documented limit).

/// The redeem timestamp is this far in the future, so the relayer has time to submit it.
pub const MESSAGE_LEAD_SECS: u64 = 10 * 60;
/// Monerium rejects messages whose timestamp is older than this.
pub const MONERIUM_TOLERANCE_SECS: u64 = 5 * 60;
/// Message Monerium requires to link an address to a profile. It cannot move funds.
pub const OWNERSHIP_MESSAGE: &str = "I hereby declare that I am the address owner.";

/// Euro cents as Monerium's `amount`: `72000` -> `"720"`, `72050` -> `"720.50"`, `5` -> `"0.05"`.
pub fn format_eur(cents: u64) -> String {
    let euros = cents / 100;
    let rest = cents % 100;
    if rest == 0 {
        euros.to_string()
    } else {
        format!("{euros}.{rest:02}")
    }
}

/// Two uppercase letters, two digits, `...`, four uppercase alphanumerics (`FR76...0189`).
pub fn is_valid_short_iban(short: &str) -> bool {
    let b = short.as_bytes();
    b.len() == 11
        && b[0].is_ascii_uppercase()
        && b[1].is_ascii_uppercase()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && &b[4..7] == b"..."
        && b[7..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// Unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's civil-from-days, public domain).
pub fn rfc3339_utc(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let (h, m, s) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn redeem_message(amount_cents: u64, short_iban: &str, unix_secs: u64) -> String {
    format!(
        "Send EUR {} to {} at {}",
        format_eur(amount_cents),
        short_iban,
        rfc3339_utc(unix_secs)
    )
}
