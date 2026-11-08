//! The Rust participant library against a relay of its own: every operation once.

use std::time::Duration;

use agentwire::chat::Ping;
use agentwire::{Client, JOIN, LEAVE, Receive};
use agentwire_relay::Relay;
use tokio::net::TcpListener;

async fn relay() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Relay::open(None, None).unwrap().router();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

#[tokio::test]
async fn every_operation() {
    let client = Client::new();
    let link = client.create(&relay().await).await.unwrap();
    let luis = client.join(&link, "luis").await.unwrap();
    let claude = client.join(&link, "luis/claude").await.unwrap();
    assert_eq!((luis.name.as_str(), luis.n, claude.n), ("luis", 1, 2));
    let taken = client.join(&link, "luis").await.unwrap_err();
    assert_eq!(taken.status(), Some(409));
    assert_eq!(client.rejoin(&luis.link).await.unwrap(), luis);

    let kind = Ping::Only(vec!["luis/claude".into()]).on("text/markdown");
    let n = client
        .send(&luis.link, &kind, None, "**Hello.**")
        .await
        .unwrap();
    let image = client
        .send(&luis.link, "image/png", Some("a plot.png"), vec![1u8, 2, 3])
        .await
        .unwrap();

    let received = client
        .receive(&claude.link, &Receive::default())
        .await
        .unwrap();
    let kinds: Vec<&str> = received.entries.iter().map(|e| e.essence()).collect();
    assert_eq!(kinds, [JOIN, "text/markdown", "image/png"]);
    let message = &received.entries[1];
    assert_eq!(
        (message.n, message.text.as_deref()),
        (n, Some("**Hello.**"))
    );
    assert!(Ping::of(&message.kind).unwrap().pings("luis/claude"));
    assert_eq!(received.presence["luis/claude"].read, image);

    let payload = client.fetch(&claude.link, image).await.unwrap();
    assert_eq!(payload.bytes, [1, 2, 3]);
    assert_eq!(payload.kind, "image/png");
    assert_eq!(payload.filename.as_deref(), Some("a plot.png"));

    let waited = Receive {
        wait: Some(Duration::from_millis(100)),
        ..Receive::default()
    };
    let nothing = client.receive(&claude.link, &waited).await.unwrap();
    assert!(nothing.entries.is_empty());
    assert_eq!(nothing.presence.len(), 2);

    let own = Receive {
        after: Some(0),
        read: Some(n),
        own: true,
        only: vec!["application/vnd.agentwire.".into()],
        wait: Some(Duration::ZERO),
        ..Receive::default()
    };
    let joins = client.receive(&luis.link, &own).await.unwrap();
    assert_eq!(joins.entries.len(), 2);
    assert_eq!(joins.presence["luis"].read, n);

    let left = client.leave(&claude.link).await.unwrap();
    let after = Receive {
        after: Some(image),
        ..Receive::default()
    };
    let received = client.receive(&luis.link, &after).await.unwrap();
    assert_eq!(received.entries[0].n, left);
    assert!(received.entries[0].is(LEAVE));
}
