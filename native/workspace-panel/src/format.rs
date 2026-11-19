use chrono::{DateTime, Local, Utc};

fn parse(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// "just now", "5 min ago", "in 3 h", then a local date.
pub(crate) fn relative(iso: &str) -> String {
    relative_to(iso, Utc::now())
}

pub(crate) fn relative_to(iso: &str, now: DateTime<Utc>) -> String {
    let Some(time) = parse(iso) else {
        return iso.to_owned();
    };
    let seconds = (now - time).num_seconds();
    let (distance, future) = (seconds.abs(), seconds < 0);
    let phrase = |amount: i64, unit: &str| {
        if future {
            format!("in {amount} {unit}")
        } else {
            format!("{amount} {unit} ago")
        }
    };
    match distance {
        0..=59 if future => "in under a minute".into(),
        0..=59 => "just now".into(),
        60..=3_599 => phrase(distance / 60, "min"),
        3_600..=86_399 => phrase(distance / 3_600, "h"),
        86_400..=604_799 => phrase(distance / 86_400, "d"),
        _ => date(iso),
    }
}

/// "Mon 17 Nov" in the local time zone, with the year when it is not this one.
pub(crate) fn date(iso: &str) -> String {
    let Some(time) = parse(iso) else {
        return iso.to_owned();
    };
    let local = time.with_timezone(&Local);
    if local.format("%Y").to_string() == Local::now().format("%Y").to_string() {
        local.format("%a %-d %b").to_string()
    } else {
        local.format("%-d %b %Y").to_string()
    }
}

/// "Mon 17 Nov, 09:30" in the local time zone.
pub(crate) fn date_time(iso: &str) -> String {
    let Some(time) = parse(iso) else {
        return iso.to_owned();
    };
    format!(
        "{}, {}",
        date(iso),
        time.with_timezone(&Local).format("%H:%M")
    )
}

pub(crate) fn file_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1_000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1_000.;
    let mut unit = 0;
    while value >= 1_000. && unit < UNITS.len() - 1 {
        value /= 1_000.;
        unit += 1;
    }
    if value < 10. {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

pub(crate) fn mime_for(file_name: &str) -> &'static str {
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// A plain-words reading of the five-field cron shapes the panel offers,
/// falling back to the expression itself.
pub(crate) fn schedule(cron: &str) -> String {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    let [minute, hour, day, month, weekday] = fields.as_slice() else {
        return cron.to_owned();
    };
    let clock = match (minute.parse::<u8>(), hour.parse::<u8>()) {
        (Ok(minute), Ok(hour)) if minute < 60 && hour < 24 => {
            Some(format!("{hour:02}:{minute:02}"))
        }
        _ => None,
    };
    match (clock, *hour, *day, *month, *weekday) {
        (None, "*", "*", "*", "*") if *minute == "0" => "Every hour".into(),
        (Some(clock), _, "*", "*", "*") => format!("Every day at {clock}"),
        (Some(clock), _, "*", "*", "1-5") => format!("Weekdays at {clock}"),
        (Some(clock), _, "*", "*", weekday) => match weekday_name(weekday) {
            Some(name) => format!("Every {name} at {clock}"),
            None => cron.to_owned(),
        },
        (Some(clock), _, "1", "*", "*") => format!("Monthly on the 1st at {clock}"),
        _ => cron.to_owned(),
    }
}

fn weekday_name(field: &str) -> Option<&'static str> {
    Some(match field {
        "0" | "7" => "Sunday",
        "1" => "Monday",
        "2" => "Tuesday",
        "3" => "Wednesday",
        "4" => "Thursday",
        "5" => "Friday",
        "6" => "Saturday",
        _ => return None,
    })
}

/// "waiting_input" → "Waiting input".
pub(crate) fn sentence_case(code: &str) -> String {
    let words = code.replace('_', " ");
    let mut letters = words.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => words,
    }
}

/// The invite token from a pasted `…/invite/<token>` link, or the text itself.
pub(crate) fn invite_token(pasted: &str) -> &str {
    let pasted = pasted.trim();
    let path = pasted.split(['?', '#']).next().unwrap_or(pasted);
    path.trim_end_matches('/')
        .rsplit_once("/invite/")
        .map_or(path, |(_, token)| token)
}

/// The first letters of a name's first and last words, as `native/desktop` shows them.
pub(crate) fn initials(name: &str) -> String {
    let mut letters = name
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .filter(|letter| letter.is_alphanumeric());
    let first = letters.next();
    let last = letters.last();
    first
        .into_iter()
        .chain(last)
        .flat_map(char::to_uppercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_times_read_in_both_directions() {
        let now = parse("2026-11-19T12:00:00Z").unwrap();
        assert_eq!(relative_to("2026-11-19T11:59:40Z", now), "just now");
        assert_eq!(relative_to("2026-11-19T11:15:00Z", now), "45 min ago");
        assert_eq!(relative_to("2026-11-19T15:00:00Z", now), "in 3 h");
        assert_eq!(relative_to("2026-11-16T12:00:00Z", now), "3 d ago");
        assert_eq!(relative_to("not a date", now), "not a date");
    }

    #[test]
    fn schedules_read_in_plain_words_or_stay_as_written() {
        assert_eq!(schedule("0 * * * *"), "Every hour");
        assert_eq!(schedule("30 9 * * *"), "Every day at 09:30");
        assert_eq!(schedule("0 9 * * 1-5"), "Weekdays at 09:00");
        assert_eq!(schedule("0 9 * * 1"), "Every Monday at 09:00");
        assert_eq!(schedule("0 9 1 * *"), "Monthly on the 1st at 09:00");
        assert_eq!(schedule("*/5 * * * *"), "*/5 * * * *");
    }

    #[test]
    fn invite_tokens_come_out_of_links_and_bare_text() {
        assert_eq!(
            invite_token(" https://superbot.example.com/invite/abc_DEF-123?x=1 "),
            "abc_DEF-123"
        );
        assert_eq!(invite_token("abc_DEF-123"), "abc_DEF-123");
    }

    #[test]
    fn sizes_and_types_are_readable() {
        assert_eq!(file_size(999), "999 B");
        assert_eq!(file_size(1_500), "1.5 KB");
        assert_eq!(file_size(25_000_000), "25 MB");
        assert_eq!(mime_for("Report.PDF"), "application/pdf");
        assert_eq!(mime_for("no-extension"), "application/octet-stream");
        assert_eq!(sentence_case("waiting_input"), "Waiting input");
        assert_eq!(initials("Panel Owner"), "PO");
        assert_eq!(initials("  ada "), "A");
        assert_eq!(initials(""), "");
    }
}
