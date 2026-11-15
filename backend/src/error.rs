//! A refusal: a status and one sentence, for whoever reads it, agent or person.

use axum::{
  http::{HeaderValue, StatusCode, header::RETRY_AFTER},
  response::{IntoResponse, Response},
};

#[derive(Debug)]
pub struct Refusal {
  pub status: StatusCode,
  pub message: String,
  /// Seconds after which asking again may succeed.
  pub retry_after: Option<u64>,
}

pub type Result<T, E = Refusal> = std::result::Result<T, E>;

impl Refusal {
  pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
    Self {
      status,
      message: message.into(),
      retry_after: None,
    }
  }

  pub fn bad(message: impl Into<String>) -> Self {
    Self::new(StatusCode::BAD_REQUEST, message)
  }

  pub fn forbidden(message: impl Into<String>) -> Self {
    Self::new(StatusCode::FORBIDDEN, message)
  }

  pub fn not_found(message: impl Into<String>) -> Self {
    Self::new(StatusCode::NOT_FOUND, message)
  }

  pub fn conflict(message: impl Into<String>) -> Self {
    Self::new(StatusCode::CONFLICT, message)
  }

  /// Too much at once, with when to ask again.
  pub fn busy(status: StatusCode, message: impl Into<String>, retry_after: u64) -> Self {
    Self {
      retry_after: Some(retry_after),
      ..Self::new(status, message)
    }
  }
}

impl IntoResponse for Refusal {
  fn into_response(self) -> Response {
    let mut response = (self.status, self.message).into_response();
    if let Some(seconds) = self.retry_after {
      response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from(seconds));
    }
    response
  }
}

/// A failure of the database is the backend's own, which the caller can't fix: it is logged,
/// and answered with 500.
impl From<sqlx::Error> for Refusal {
  fn from(error: sqlx::Error) -> Self {
    tracing::error!("database: {error}");
    Self::new(
      StatusCode::INTERNAL_SERVER_ERROR,
      "The backend failed: try again later.",
    )
  }
}

/// Whether `error` is a unique constraint that failed, such as a name taken.
pub fn is_taken(error: &sqlx::Error) -> bool {
  matches!(error, sqlx::Error::Database(e) if e.is_unique_violation())
}
