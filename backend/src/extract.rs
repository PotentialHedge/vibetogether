//! axum's extractors, refusing a malformed request with 400 and one sentence on what is wrong.

use axum::extract::{
  FromRequest, FromRequestParts,
  rejection::{JsonRejection, PathRejection, QueryRejection},
};

use crate::error::Refusal;

#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(Refusal))]
pub struct Json<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(Refusal))]
pub struct Query<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Path), rejection(Refusal))]
pub struct Path<T>(pub T);

impl From<JsonRejection> for Refusal {
  fn from(rejection: JsonRejection) -> Self {
    Refusal::bad(rejection.body_text())
  }
}

impl From<QueryRejection> for Refusal {
  fn from(rejection: QueryRejection) -> Self {
    Refusal::bad(rejection.body_text())
  }
}

impl From<PathRejection> for Refusal {
  fn from(rejection: PathRejection) -> Self {
    Refusal::bad(rejection.body_text())
  }
}
