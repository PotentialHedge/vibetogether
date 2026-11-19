//! A server with an owner, as one runs privately: whoever reaches it is its owner.

mod common;

use common::*;
use reqwest::{StatusCode, header};
use vibetogether_backend::Identity;
use vibetogether_client::Client;
use vibetogether_protocol::{Otp, OtpRedeem, OtpRequest, OverviewQuery, TokenKind};

async fn owned() -> common::Server {
  let identity = Identity::Owner {
    name: "luiswirth".into(),
  };
  let site = scratch().join("site");
  std::fs::create_dir_all(site.join("i")).unwrap();
  std::fs::write(site.join("index.html"), "greeting").unwrap();
  std::fs::write(site.join("i/index.html"), "invite").unwrap();
  server_as(scratch().join("backend.db"), identity, Some(site)).await
}

#[tokio::test]
async fn whoever_reaches_it_is_its_owner() {
  let server = owned().await;
  let anyone = Client::new(&server.url, None);
  let info = anyone.server_info().await.unwrap();
  assert_eq!(info.identity, vibetogether_protocol::Identity::Owner);
  assert_eq!(info.owner.as_deref(), Some("luiswirth"));
  // An OTP approves itself, and its token is the owner's.
  let otp = anyone
    .request_otp(&OtpRequest {
      kind: TokenKind::Agent,
      name: "laptop".into(),
    })
    .await
    .unwrap();
  let token = anyone.redeem_otp(&otp.secret).await.unwrap();
  assert_eq!(token.account, "luiswirth");
  let machine = Client::new(&server.url, Some(token.token));
  let agent = machine.create_agent("lead").await.unwrap();
  let lead = machine.acting_as(Some(agent.id));
  let overview = lead.overview(&OverviewQuery::default()).await.unwrap();
  assert_eq!(overview.groups.len(), 1);
  assert!(overview.groups[0].group.own);
  // A sign-in is made at once, and lands where it was asked to.
  let http = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .unwrap();
  let answer = http
    .get(format!(
      "{}/api/auth/sign-in?callback=%2Faccount%2F",
      server.url
    ))
    .send()
    .await
    .unwrap();
  assert_eq!(answer.status(), StatusCode::SEE_OTHER);
  assert_eq!(answer.headers()[header::LOCATION], "/account/");
  let cookie = answer.headers()[header::SET_COOKIE].to_str().unwrap();
  let secret = cookie
    .strip_prefix("vibetogether.session_token=")
    .and_then(|c| c.split(';').next())
    .unwrap();
  assert_eq!(server.browser(secret).me().await.unwrap().name, "luiswirth");
}

#[tokio::test]
async fn a_page_on_another_site_is_not_the_owner() {
  let server = owned().await;
  let http = reqwest::Client::new();
  let answer = http
    .post(format!("{}/api/otp", server.url))
    .header(header::ORIGIN, "https://evil.example")
    .json(&OtpRequest {
      kind: TokenKind::App,
      name: "evil".into(),
    })
    .send()
    .await
    .unwrap();
  assert_eq!(answer.status(), StatusCode::CREATED);
  let otp: Otp = answer.json().await.unwrap();
  let redeem = http
    .post(format!("{}/api/otp/redeem", server.url))
    .json(&OtpRedeem {
      secret: otp.secret,
      wait: Some(1),
    })
    .send()
    .await
    .unwrap();
  assert_eq!(redeem.status(), StatusCode::REQUEST_TIMEOUT);
}

#[tokio::test]
async fn it_answers_only_at_its_own_host() {
  let server = owned().await;
  let port = server.url.rsplit(':').next().unwrap();
  let http = reqwest::Client::new();
  let elsewhere = http
    .get(format!("{}/api/server", server.url))
    .header(header::HOST, format!("rebound.example:{port}"))
    .send()
    .await
    .unwrap();
  assert_eq!(elsewhere.status(), StatusCode::MISDIRECTED_REQUEST);
  let own = http
    .get(format!("{}/api/server", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(own.status(), StatusCode::OK);
}

#[tokio::test]
async fn it_serves_the_website() {
  let server = owned().await;
  let page = |path: &str| reqwest::get(format!("{}{path}", server.url));
  let root = page("/").await.unwrap();
  assert!(root.headers().contains_key(header::CONTENT_SECURITY_POLICY));
  assert_eq!(root.text().await.unwrap(), "greeting");
  assert_eq!(
    page("/i/k3x9").await.unwrap().text().await.unwrap(),
    "invite"
  );
  assert_eq!(
    page("/nothing").await.unwrap().status(),
    StatusCode::NOT_FOUND
  );
}
