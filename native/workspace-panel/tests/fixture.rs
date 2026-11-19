//! Runs the server calls behind the panel's flows against an isolated fixture.
//!
//! Skipped unless `SUPERBOT_FIXTURE` (the origin), `SUPERBOT_FIXTURE_OWNER`,
//! `SUPERBOT_FIXTURE_GUEST` (two synthetic accounts) and
//! `SUPERBOT_FIXTURE_PASSWORD` (the password they share) are set. It writes
//! data, so point it only at a disposable fixture.

use superbot_client::{Client, Error};
use superbot_features::{
    ApprovalEffect, ApprovalMatch, ApprovalMode, CreateBot, CreateRoutine, Features, RoutineUpdate,
    RunFilter, SpaceSetting,
};

struct Fixture {
    owner: Features,
    guest: Features,
    guest_client: Client,
    space_id: String,
}

async fn fixture() -> Option<Fixture> {
    let var = |name: &str| std::env::var(name).ok();
    let (origin, owner, guest, password) = (
        var("SUPERBOT_FIXTURE")?,
        var("SUPERBOT_FIXTURE_OWNER")?,
        var("SUPERBOT_FIXTURE_GUEST")?,
        var("SUPERBOT_FIXTURE_PASSWORD")?,
    );
    assert!(
        owner.ends_with("@example.test") && guest.ends_with("@example.test"),
        "use synthetic @example.test accounts"
    );
    let client = Client::new(&origin).expect("fixture origin");
    let owner = client
        .sign_in(&owner, &password)
        .await
        .expect("owner sign-in");
    let guest = client
        .sign_in(&guest, &password)
        .await
        .expect("guest sign-in");
    let space_id = owner
        .list_spaces()
        .await
        .expect("owner spaces")
        .into_iter()
        .next()
        .expect("the owner has a space")
        .id;
    Some(Fixture {
        owner: Features::new(owner),
        guest: Features::new(guest.clone()),
        guest_client: guest,
        space_id,
    })
}

fn status(error: &Error) -> Option<u16> {
    match error {
        Error::Server { status, .. } => Some(*status),
        _ => None,
    }
}

#[tokio::test]
async fn routines_follow_the_panel_flow() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let space = fixture.owner.space(&fixture.space_id);
    let bot = space
        .create_bot(&CreateBot {
            name: "Routine fixture bot",
            ..Default::default()
        })
        .await
        .expect("create bot");

    let created = space
        .create_routine(&CreateRoutine {
            bot_id: &bot.id,
            name: "Morning brief",
            prompt: "Summarise yesterday.",
            crons: Some(&["0 9 * * 1-5"]),
            active: Some(true),
            notify: Some(true),
            in_chat: Some(false),
            ..Default::default()
        })
        .await
        .expect("create routine");
    assert_eq!(created.crons, ["0 9 * * 1-5"]);
    assert!(created.active);

    let listed = space.list_routines(&bot.id).await.expect("list routines");
    assert!(listed.iter().any(|routine| routine.id == created.id));

    let paused = space
        .update_routine(
            &created.id,
            &RoutineUpdate {
                name: Some("Morning brief, weekdays"),
                crons: Some(&["30 8 * * 1-5"]),
                in_chat: Some(true),
                active: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("update routine");
    assert_eq!(paused.name, "Morning brief, weekdays");
    assert_eq!(paused.crons, ["30 8 * * 1-5"]);
    assert!(paused.in_chat && !paused.active);

    let history = space
        .routine_history(&created.id, None, Some(20))
        .await
        .expect("routine history");
    assert!(history.runs.is_empty());

    space
        .remove_routine(&created.id)
        .await
        .expect("remove routine");
    let listed = space.list_routines(&bot.id).await.expect("list routines");
    assert!(listed.iter().all(|routine| routine.id != created.id));

    space.archive_bot(&bot.id).await.expect("archive bot");
}

#[tokio::test]
async fn approvals_and_activity_follow_the_panel_flow() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let space = fixture.owner.space(&fixture.space_id);

    let review = space.auto_review(None).await.expect("read approval mode");
    let asked = space
        .set_auto_review(None, ApprovalMode::Ask)
        .await
        .expect("set approval mode");
    assert!(matches!(asked.mode, ApprovalMode::Ask));
    space
        .set_auto_review(None, review.mode)
        .await
        .expect("restore approval mode");

    let rule = space
        .set_approval_rule(
            None,
            ApprovalEffect::RequireApproval,
            ApprovalMatch::Site("fixture.example.test"),
        )
        .await
        .expect("add rule");
    let rules = space.approval_rules(None).await.expect("list rules");
    assert!(rules.iter().any(|listed| listed.id == rule.id));
    space
        .remove_approval_rule(None, &rule.id)
        .await
        .expect("remove rule");
    let rules = space.approval_rules(None).await.expect("list rules");
    assert!(rules.iter().all(|listed| listed.id != rule.id));

    let own = |overrides: &[SpaceSetting]| {
        overrides
            .iter()
            .any(|setting| matches!(setting, SpaceSetting::Confirmations))
    };
    let before = own(&space.setting_overrides().await.expect("read overrides"));
    let flipped = space
        .set_setting_override(SpaceSetting::Confirmations, !before)
        .await
        .expect("set override");
    assert_eq!(own(&flipped), !before);
    let restored = space
        .set_setting_override(SpaceSetting::Confirmations, before)
        .await
        .expect("restore override");
    assert_eq!(own(&restored), before);

    space
        .list_runs(RunFilter::Active)
        .await
        .expect("active runs");
    space
        .list_runs(RunFilter::Recent)
        .await
        .expect("recent runs");
}

#[tokio::test]
async fn a_guest_joins_by_link_is_refused_owner_actions_and_leaves() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let owner_space = fixture.owner.space(&fixture.space_id);
    let guest_space = fixture.guest.space(&fixture.space_id);

    if guest_space.members().await.is_ok() {
        guest_space
            .leave()
            .await
            .expect("leave from an earlier run");
    }
    // A Space the account is not in is refused as unauthorized, like a dead session.
    let outside = guest_space.members().await.expect_err("not a member yet");
    assert_eq!(status(&outside), Some(401));
    fixture
        .guest
        .space(&guest_home(&fixture).await)
        .list_bots()
        .await
        .expect("the guest's session still works in their own space");

    let link = owner_space.create_invite(None).await.expect("invite link");
    let token = link.url.rsplit('/').next().expect("link token").to_owned();
    let preview = fixture
        .guest
        .preview_space_invite(&token)
        .await
        .expect("preview invite");
    assert_eq!(preview.space_id, fixture.space_id);
    assert!(!preview.already_member);
    let joined = fixture
        .guest
        .accept_space_invite(&token)
        .await
        .expect("accept invite");
    assert_eq!(joined, fixture.space_id);

    let roster = guest_space.members().await.expect("guest sees the roster");
    assert!(!roster.can_manage);
    assert!(roster.members.len() >= 2);
    assert!(
        owner_space
            .members()
            .await
            .expect("owner roster")
            .can_manage
    );

    let refused = guest_space
        .create_invite(None)
        .await
        .err()
        .expect("a guest cannot invite");
    assert_eq!(status(&refused), Some(403));
    let refused = guest_space
        .cancel_invites()
        .await
        .expect_err("a guest cannot cancel invites");
    assert_eq!(status(&refused), Some(403));

    guest_space.leave().await.expect("guest leaves");
    let gone = guest_space.members().await.expect_err("no longer a member");
    assert_eq!(status(&gone), Some(401));

    owner_space
        .cancel_invites()
        .await
        .expect("cancel unused links");
    let roster = owner_space.members().await.expect("owner roster");
    assert_eq!(roster.open_invites.unwrap_or(0), 0);
}

async fn guest_home(fixture: &Fixture) -> String {
    let home: serde_json::Value = fixture
        .guest_client
        .rpc("spaces/list", None, serde_json::json!({}))
        .await
        .expect("guest spaces");
    home["current"]["id"].as_str().expect("space id").to_owned()
}
