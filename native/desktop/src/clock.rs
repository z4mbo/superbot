//! When a message was said, read from the server's time and shown in the person's own.

use chrono::{DateTime, Duration, TimeZone};

/// A moment as milliseconds since the Unix epoch.
pub type Instant = i64;

pub fn now() -> Instant {
    chrono::Utc::now().timestamp_millis()
}

/// The moment an RFC 3339 time names, as the server writes `createdAt`.
pub fn instant(rfc3339: &str) -> Option<Instant> {
    DateTime::parse_from_rfc3339(rfc3339).ok().map(|time| time.timestamp_millis())
}

/// A quiet spell this long gets the time stamped again, as the day changing does.
const STAMP_GAP_MS: i64 = 15 * 60_000;

fn local<Tz: TimeZone>(at: Instant, zone: &Tz) -> Option<DateTime<Tz>> {
    zone.timestamp_millis_opt(at).single()
}

/// Whether the time is stamped above a message: the first one, the first of a day, and the
/// first after a quiet spell.
pub fn needs_stamp<Tz: TimeZone>(previous: Option<Instant>, at: Instant, zone: &Tz) -> bool {
    let Some(previous) = previous else { return true };
    let day = |moment| local(moment, zone).map(|time| time.date_naive());
    day(previous) != day(at) || at - previous >= STAMP_GAP_MS
}

/// The stamp between messages: "Today 9:41 AM", "Yesterday 4:05 PM", "Mon, Nov 17 9:41 AM".
pub fn stamp<Tz: TimeZone>(at: Instant, now: Instant, zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let (Some(time), Some(today)) = (local(at, zone), local(now, zone)) else {
        return String::new();
    };
    let (day, today) = (time.date_naive(), today.date_naive());
    let clock = time.format("%-I:%M %p");
    if day == today {
        format!("Today {clock}")
    } else if day + Duration::days(1) == today {
        format!("Yesterday {clock}")
    } else {
        format!("{} {clock}", time.format("%a, %b %-d"))
    }
}

/// The whole date and time, for the tooltip on one message.
pub fn full<Tz: TimeZone>(at: Instant, zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    local(at, zone).map(|time| time.format("%a, %b %-d, %Y, %-I:%M %p").to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(rfc3339: &str) -> Instant {
        instant(rfc3339).unwrap()
    }

    #[test]
    fn a_stamp_names_the_day_as_the_person_lives_it() {
        let rome = FixedOffset::east_opt(3600).unwrap();
        let now = at("2026-11-19T10:00:00Z");
        assert_eq!(stamp(at("2026-11-19T08:41:00Z"), now, &rome), "Today 9:41 AM");
        assert_eq!(stamp(at("2026-11-18T15:05:00Z"), now, &rome), "Yesterday 4:05 PM");
        assert_eq!(stamp(at("2026-11-16T08:41:00Z"), now, &rome), "Mon, Nov 16 9:41 AM");
        // 23:30 UTC is already tomorrow in Rome.
        assert_eq!(stamp(at("2026-11-18T23:30:00Z"), now, &rome), "Today 12:30 AM");
        assert_eq!(full(at("2026-11-16T08:41:00Z"), &rome), "Mon, Nov 16, 2026, 9:41 AM");
    }

    #[test]
    fn the_time_is_stamped_on_the_first_message_a_new_day_and_after_a_quiet_spell() {
        let utc = chrono::Utc;
        let first = at("2026-11-19T09:00:00Z");
        assert!(needs_stamp(None, first, &utc));
        assert!(!needs_stamp(Some(first), at("2026-11-19T09:14:59Z"), &utc));
        assert!(needs_stamp(Some(first), at("2026-11-19T09:15:00Z"), &utc));
        assert!(needs_stamp(Some(at("2026-11-18T23:59:00Z")), at("2026-11-19T00:01:00Z"), &utc));
    }

    #[test]
    fn a_time_the_server_did_not_write_as_rfc_3339_is_no_time() {
        assert_eq!(instant("yesterday"), None);
        assert_eq!(instant("2026-11-19T08:00:00.000Z"), Some(1_795_075_200_000));
    }
}
