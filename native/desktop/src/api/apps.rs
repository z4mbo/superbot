use serde::Deserialize;
use serde_json::{json, Map, Value};
use superbot_client::Error;

use super::Api;

/// The page size the record list asks for.
pub const RECORDS_PAGE: u32 = 20;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppRecord {
    pub id: String,
    pub values: Map<String, Value>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppRecords {
    pub items: Vec<AppRecord>,
    pub next_after: Option<String>,
    /// The sum of the summary field over every record the filter matches, or none when the app
    /// declares no summary field.
    pub total: Option<f64>,
}

/// Which records of one installed app part to read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordQuery {
    pub after: Option<String>,
    /// A `YYYY-MM-DD` day, matched against the app's first date field.
    pub date: Option<String>,
}

impl Api {
    pub async fn app_records(
        &self,
        space_id: &str,
        installation_id: &str,
        part_id: &str,
        query: &RecordQuery,
    ) -> Result<AppRecords, Error> {
        let mut input = json!({ "installationId": installation_id, "partId": part_id, "limit": RECORDS_PAGE });
        if let Some(after) = &query.after {
            input["after"] = json!(after);
        }
        if let Some(date) = &query.date {
            input["date"] = json!(date);
        }
        self.client.rpc("pluginRegistry/appRecords", Some(space_id), input).await
    }

    /// Saves one record. Sending the same `operation_id` and values again returns the record the
    /// first call made instead of adding another.
    pub async fn add_app_record(
        &self,
        space_id: &str,
        installation_id: &str,
        part_id: &str,
        operation_id: &str,
        values: &Map<String, Value>,
    ) -> Result<AppRecord, Error> {
        let input = json!({
            "installationId": installation_id,
            "partId": part_id,
            "operationId": operation_id,
            "values": values,
        });
        self.client.rpc("pluginRegistry/addAppRecord", Some(space_id), input).await
    }

    pub async fn remove_app_record(
        &self,
        space_id: &str,
        installation_id: &str,
        part_id: &str,
        record_id: &str,
    ) -> Result<(), Error> {
        let input = json!({ "installationId": installation_id, "partId": part_id, "recordId": record_id });
        self.done("pluginRegistry/removeAppRecord", space_id, input).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::AppRecords;

    #[test]
    fn a_record_page_reads_its_cursor_and_total() {
        let page: AppRecords = serde_json::from_value(json!({
            "items": [{
                "id": "6f1c1a52-6a43-4d1e-9e43-9a1f3f0b2c11",
                "values": { "food": "Oatmeal", "kcal": 320, "day": "2026-11-20" },
                "createdAt": "2026-11-20T08:00:00.000Z"
            }],
            "nextAfter": "6f1c1a52-6a43-4d1e-9e43-9a1f3f0b2c11",
            "total": 320.0
        }))
        .unwrap();
        assert_eq!(page.items[0].values["kcal"], json!(320));
        assert_eq!(page.total, Some(320.0));
        let plain: AppRecords =
            serde_json::from_value(json!({ "items": [], "nextAfter": null, "total": null })).unwrap();
        assert_eq!((plain.next_after, plain.total), (None, None));
    }
}
