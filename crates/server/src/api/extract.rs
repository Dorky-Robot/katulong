//! Custom axum extractors that keep the error envelope stable.
//!
//! Axum's default `Json<T>` returns a bespoke 400 when the body fails
//! to parse, with a body that names the offending field (e.g. `"Failed
//! to deserialize the JSON body: missing field 'challenge_id'"`). That
//! leaks request-struct field names to clients and — more importantly
//! — bypasses the `ApiError` envelope (`{"error": {"code": ..., "message":
//! ...}}`) that every other failure in this crate renders. `JsonBody<T>`
//! wraps the same parse logic but routes its rejection through
//! `ApiError::BadRequest`, so a malformed JSON body looks identical to
//! any other 400 on the wire.

use crate::api::error::ApiError;
use axum::{
    extract::{rejection::JsonRejection, FromRequest, Request},
    Json,
};
use serde::de::DeserializeOwned;

pub struct JsonBody<T>(pub T);

#[axum::async_trait]
impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rej) => {
                // Log the rejection's detail server-side so operators can
                // diagnose malformed clients; keep the response body generic.
                tracing::warn!(error = %rej, "malformed request body");
                Err(match rej {
                    JsonRejection::JsonDataError(_) => {
                        ApiError::BadRequest("request body does not match expected shape")
                    }
                    JsonRejection::JsonSyntaxError(_) => {
                        ApiError::BadRequest("request body is not valid JSON")
                    }
                    JsonRejection::MissingJsonContentType(_) => {
                        ApiError::BadRequest("Content-Type must be application/json")
                    }
                    _ => ApiError::BadRequest("malformed request body"),
                })
            }
        }
    }
}
