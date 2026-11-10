//! The account service's operations as tools.
//!
//! The service's OpenAPI document (`/api/openapi.json`) is the only definition of an
//! operation. The server reads it and offers each operation a token may call as a tool
//! of the same name, with the operation's description and arguments, and calls it as the
//! same HTTP request with the agent's token. So the tools cover the API by construction,
//! and an agent reads the same words here as in the reference agents read with curl.
//! The concepts, the document's tags, go into the server's instructions.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Method;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};
use serde_json::{Map, Value};

use crate::accounts::Accounts;

/// How long a document read is used before it is read again.
const FRESH: Duration = Duration::from_secs(60);
/// How long the service may take to answer.
const ANSWER: Duration = Duration::from_secs(10);
/// How deep a schema's references are followed.
const DEPTH: usize = 16;

/// One operation, as a tool and as the request that makes it.
pub(crate) struct Operation {
    pub(crate) tool: Tool,
    method: Method,
    /// Its path under `/api`, with its parameters as `{name}`.
    path: String,
    /// Whether it takes a JSON body, made of the arguments that aren't in its path.
    body: bool,
}

/// What the server read of the document.
pub(crate) struct Catalogue {
    pub(crate) operations: Vec<Operation>,
    /// The concepts, each as its name and paragraph.
    pub(crate) concepts: Vec<(String, String)>,
}

impl Catalogue {
    pub(crate) fn find(&self, name: &str) -> Option<&Operation> {
        self.operations.iter().find(|op| op.tool.name == name)
    }

    /// The concepts, as the server's instructions add them.
    pub(crate) fn instructions(&self) -> String {
        let concepts: Vec<String> = self
            .concepts
            .iter()
            .map(|(name, text)| format!("{name}: {text}"))
            .collect();
        format!(
            "Your person's Vibe Together account, which the other tools act on, with their token:\n{}",
            concepts.join("\n")
        )
    }
}

/// The document as last read, and when.
#[derive(Default)]
pub(crate) struct Cache(Mutex<Option<(Instant, Arc<Catalogue>)>>);

impl Cache {
    /// What was read last, however old, without reading.
    pub(crate) fn last(&self) -> Option<Arc<Catalogue>> {
        self.0.lock().unwrap().as_ref().map(|(_, c)| c.clone())
    }
}

impl Accounts {
    /// The operations, read again where the last read is older than `FRESH`; where the
    /// service doesn't answer, the last read, if any.
    pub(crate) async fn catalogue(&self, reserved: &[&str]) -> Result<Arc<Catalogue>, String> {
        if let Some((read, catalogue)) = &*self.cache.0.lock().unwrap()
            && read.elapsed() < FRESH
        {
            return Ok(catalogue.clone());
        }
        let document = async {
            self.http
                .get(format!("{}/api/openapi.json", self.service))
                .timeout(ANSWER)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json::<Value>()
                .await
                .ok()
        }
        .await;
        match document {
            Some(document) => {
                let catalogue = Arc::new(read(&document, reserved));
                *self.cache.0.lock().unwrap() = Some((Instant::now(), catalogue.clone()));
                Ok(catalogue)
            }
            None => self
                .cache
                .last()
                .ok_or_else(|| "the account service doesn't answer; try again later".to_owned()),
        }
    }

    /// Calls `operation` with `arguments`, as the agent whose token is `token`.
    pub(crate) async fn call(
        &self,
        operation: &Operation,
        token: &str,
        mut arguments: JsonObject,
    ) -> CallToolResult {
        let fail = |text: String| CallToolResult::error(vec![ContentBlock::text(text)]);
        let Ok(mut url) = reqwest::Url::parse(&format!("{}/api", self.service)) else {
            return fail("the account service's URL is malformed".to_owned());
        };
        {
            let Ok(mut segments) = url.path_segments_mut() else {
                return fail("the account service's URL is malformed".to_owned());
            };
            for segment in operation.path.split('/').filter(|s| !s.is_empty()) {
                match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                    Some(name) => {
                        let value = match arguments.remove(name) {
                            Some(Value::String(value)) => value,
                            Some(Value::Number(value)) => value.to_string(),
                            _ => return fail(format!("give `{name}`, as text")),
                        };
                        // Pushed as one segment, encoded, so that no argument reaches another path.
                        segments.push(&value);
                    }
                    None => {
                        segments.push(segment);
                    }
                }
            }
        }
        let mut request = self
            .http
            .request(operation.method.clone(), url)
            .bearer_auth(token)
            .timeout(ANSWER);
        if operation.body {
            request = request.json(&Value::Object(arguments));
        } else if let Some(name) = arguments.keys().next() {
            return fail(format!("`{name}` is no argument of this tool"));
        }
        let unreachable = |_| "the account service doesn't answer; try again later".to_owned();
        let answer = match request.send().await.map_err(unreachable) {
            Ok(answer) => answer,
            Err(why) => return fail(why),
        };
        let status = answer.status();
        let text = answer.text().await.unwrap_or_default();
        if status.is_success() {
            let text = if text.is_empty() {
                "Done.".to_owned()
            } else {
                text
            };
            CallToolResult::success(vec![ContentBlock::text(text)])
        } else {
            // The service's refusals are one sentence of its own, for the agent.
            let why: String = text.trim().chars().take(500).collect();
            fail(format!("the account service refused ({status}): {why}"))
        }
    }
}

/// The operations of `document` a token may call, but those named in `reserved`, the
/// server's own tools.
fn read(document: &Value, reserved: &[&str]) -> Catalogue {
    let mut operations = Vec::new();
    for (path, item) in document["paths"].as_object().into_iter().flatten() {
        for (method, op) in item.as_object().into_iter().flatten() {
            let Ok(method) = method.to_uppercase().parse::<Method>() else {
                continue;
            };
            let Some(id) = op["operationId"].as_str() else {
                continue;
            };
            // A token may call it where it needs nothing, or takes a token.
            let callable = op["security"].as_array().is_none_or(|ways| {
                ways.is_empty()
                    || ways.iter().any(|way| {
                        way.as_object()
                            .is_some_and(|w| w.is_empty() || w.contains_key("token"))
                    })
            });
            // An operation the document marks as no tool, such as getting a token by OTP,
            // which an MCP client does by OAuth instead.
            if !callable || reserved.contains(&id) || op["x-tool"] == false {
                continue;
            }
            let mut properties = Map::new();
            let mut required = Vec::new();
            for parameter in op["parameters"].as_array().into_iter().flatten() {
                let parameter = resolve(document, parameter, 0);
                if parameter["in"] != "path" {
                    continue;
                }
                let Some(name) = parameter["name"].as_str() else {
                    continue;
                };
                let mut schema = resolve(document, &parameter["schema"], 0);
                if let (Some(description), Some(object)) =
                    (parameter["description"].as_str(), schema.as_object_mut())
                {
                    object.insert("description".into(), description.into());
                }
                properties.insert(name.to_owned(), schema);
                required.push(Value::from(name));
            }
            let body = &op["requestBody"]["content"]["application/json"]["schema"];
            let takes_body = !body.is_null();
            if takes_body {
                let body = resolve(document, body, 0);
                for (name, schema) in body["properties"].as_object().into_iter().flatten() {
                    properties.insert(name.clone(), schema.clone());
                }
                required.extend(body["required"].as_array().into_iter().flatten().cloned());
            }
            let mut schema = JsonObject::new();
            schema.insert("type".into(), "object".into());
            schema.insert("properties".into(), Value::Object(properties));
            if !required.is_empty() {
                schema.insert("required".into(), Value::Array(required));
            }
            let description = op["description"]
                .as_str()
                .or(op["summary"].as_str())
                .unwrap_or_default()
                .to_owned();
            let mut tool = Tool::new(id.to_owned(), description, schema).with_annotations(
                ToolAnnotations::new()
                    .read_only(method == Method::GET)
                    .destructive(method == Method::DELETE)
                    .open_world(false),
            );
            if let Some(summary) = op["summary"].as_str() {
                tool = tool.with_title(summary);
            }
            operations.push(Operation {
                tool,
                method,
                path: path.clone(),
                body: takes_body,
            });
        }
    }
    let concepts = document["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            Some((
                tag["name"].as_str()?.to_owned(),
                tag["description"].as_str()?.to_owned(),
            ))
        })
        .collect();
    Catalogue {
        operations,
        concepts,
    }
}

/// `value` with every reference into the document's components replaced by what it names.
fn resolve(document: &Value, value: &Value, depth: usize) -> Value {
    if depth > DEPTH {
        return Value::Object(Map::new());
    }
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str)
                && let Some(pointer) = reference.strip_prefix('#')
            {
                return resolve(
                    document,
                    document.pointer(pointer).unwrap_or(&Value::Null),
                    depth + 1,
                );
            }
            Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), resolve(document, value, depth + 1)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| resolve(document, value, depth + 1))
                .collect(),
        ),
        value => value.clone(),
    }
}
