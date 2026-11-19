use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Acknowledgement, Error, Features, SpaceFeatures};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceRole {
    Owner,
    Member,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub image: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SpaceMember {
    #[serde(flatten)]
    pub person: Person,
    pub role: SpaceRole,
    pub guest: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMembers {
    pub space_name: String,
    pub members: Vec<SpaceMember>,
    pub can_manage: bool,
    pub open_invites: Option<u64>,
    pub addable: Option<Vec<Person>>,
    pub organization_name: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteLink {
    pub url: String,
    pub expires_at: String,
    pub emailed: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    pub space_id: String,
    pub space_name: String,
    pub inviter_name: String,
    pub already_member: bool,
}

impl Features {
    pub async fn preview_space_invite(&self, token: &str) -> Result<InvitePreview, Error> {
        self.call("spaces/invites/preview", None, json!({ "token": token }))
            .await
    }

    pub async fn accept_space_invite(&self, token: &str) -> Result<String, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Joined {
            space_id: String,
        }
        let joined: Joined = self
            .call("spaces/invites/accept", None, json!({ "token": token }))
            .await?;
        Ok(joined.space_id)
    }
}

impl SpaceFeatures<'_> {
    pub async fn members(&self) -> Result<SpaceMembers, Error> {
        self.call("spaces/members/list", json!({ "spaceId": self.id }))
            .await
    }

    pub async fn add_member(&self, user_id: &str) -> Result<(), Error> {
        self.acknowledge(
            "spaces/members/add",
            json!({ "spaceId": self.id, "userId": user_id }),
        )
        .await
    }

    pub async fn remove_member(&self, user_id: &str) -> Result<(), Error> {
        self.acknowledge(
            "spaces/members/remove",
            json!({ "spaceId": self.id, "userId": user_id }),
        )
        .await
    }

    pub async fn leave(&self) -> Result<String, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ResultingSpace {
            #[serde(flatten)]
            acknowledgement: Acknowledgement,
            active_space_id: String,
        }
        let result: ResultingSpace = self
            .call("spaces/members/leave", json!({ "spaceId": self.id }))
            .await?;
        result.acknowledgement.validate()?;
        Ok(result.active_space_id)
    }

    pub async fn create_invite(&self, email: Option<&str>) -> Result<InviteLink, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            space_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            email: Option<&'a str>,
        }
        self.call(
            "spaces/invites/create",
            Input {
                space_id: &self.id,
                email,
            },
        )
        .await
    }

    pub async fn cancel_invites(&self) -> Result<(), Error> {
        self.acknowledge("spaces/invites/cancel", json!({ "spaceId": self.id }))
            .await
    }
}
