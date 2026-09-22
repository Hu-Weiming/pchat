use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::{watch, Mutex as AsyncMutex};
use crate::settings;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenRequest { connection_id: String, attempt_id: String, operation: String, body: Value }
struct Body { response: Option<reqwest::Response>, bytes: usize, remaining: Vec<u8> }
struct Call { attempt_id: String, cancel: watch::Sender<bool>, body: AsyncMutex<Body>, started: Instant }
#[derive(Default, Clone)]
pub struct Network(Arc<Mutex<HashMap<String, Arc<Call>>>>);

fn endpoint(request: &OpenRequest) -> Result<&'static str, String> {
    if request.attempt_id.is_empty() || request.attempt_id.len() > 200 { return Err("REJECTED".into()); }
    let fields = request.body.as_object().ok_or("REJECTED")?;
    let (connection, endpoint, allowed): (&str, &str, &[&str]) = match request.operation.as_str() {
        "deepseek.chat" => ("deepseek-personal", "https://api.deepseek.com/chat/completions", &["model","stream","response_format","max_tokens","temperature","top_p","messages","thinking"]),
        "qianfan.search" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/knowledgebases/search", &["query","knowledgebase_ids","metadata_filters","recall","rerank","top_k","score_threshold","enable_graph","enable_expansion"]),
        "qianfan.documents" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/knowledgeBase?Action=DescribeDocuments", &["knowledgeBaseId","marker","maxKeys"]),
        "qianfan.chunks" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/knowledgeBase?Action=DescribeChunks", &["knowledgeBaseId","documentId","marker","maxKeys"]),
        "qianfan.chunk" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/knowledgeBase?Action=DescribeChunk", &["knowledgeBaseId","chunkId"]),
        "qianfan.conversation" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/app/conversation", &["app_id"]),
        "qianfan.workflow" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/app/conversation/runs", &["app_id","conversation_id","query","stream","parameters"]),
        #[cfg(test)]
        "qianfan.traceRun" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/app/chatflow/async/run", &["app_id","parameters"]),
        #[cfg(test)]
        "qianfan.traceRetrieve" => ("qianfan-personal", "https://qianfan.baidubce.com/v2/app/chatflow/async/retrieve", &["execute_id"]),
        _ => return Err("REJECTED".into()),
    };
    if request.connection_id != connection || fields.keys().any(|key| !allowed.contains(&key.as_str())) || request.body.to_string().len() > 8_000_000 { return Err("REJECTED".into()); }
    if request.operation == "deepseek.chat" {
        if request.body.get("thinking").is_some_and(|value| *value != json!({"type":"disabled"})) { return Err("REJECTED".into()); }
        let config = settings::configuration().map_err(|_| "REJECTED")?;
        if request.body["stream"] != true || request.body["response_format"] != json!({"type":"json_object"}) || !config["models"].as_array().ok_or("REJECTED")?.iter().any(|model| model["binding"]["connectionId"] == request.connection_id && model["binding"]["modelId"] == request.body["model"] && request.body["max_tokens"].as_u64().is_some_and(|tokens| tokens > 0 && tokens <= model["maxOutputTokens"].as_u64().unwrap_or(0))) { return Err("REJECTED".into()); }
        let messages = request.body["messages"].as_array().ok_or("REJECTED")?;
        if messages.len() != 2 || messages[0]["role"] != "system" || messages[1]["role"] != "user" || messages.iter().any(|message| message.as_object().is_none_or(|map| map.len() != 2) || !message["content"].is_string()) { return Err("REJECTED".into()); }
    }
    if request.operation == "qianfan.conversation" || request.operation == "qianfan.workflow" {
        let config = settings::configuration().map_err(|_| "REJECTED")?;
        let bindings = config["workflowRetrieval"].as_array().ok_or("REJECTED")?;
        if !bindings.iter().any(|binding| binding["binding"]["connectionId"] == request.connection_id && binding["appId"] == request.body["app_id"]) { return Err("REJECTED".into()); }
        if request.operation == "qianfan.workflow" {
            let parameters = request.body["parameters"].as_object().ok_or("REJECTED")?;
            if parameters.len() != 2 || request.body["stream"] != false || request.body["conversation_id"].as_str().is_none_or(|s| s.is_empty() || s.len() > 200)
                || request.body["query"].as_str().is_none_or(|s| s.trim().is_empty() || s.chars().count() > 32000)
                || !bindings.iter().any(|binding| binding["appId"] == request.body["app_id"] && binding["group"] == request.body["parameters"]["group"] && binding["person"] == request.body["parameters"]["per"]) { return Err("REJECTED".into()); }
        }
    }
    #[cfg(test)]
    if request.operation == "qianfan.traceRun" {
        let config = settings::configuration().map_err(|_| "REJECTED")?;
        let parameters = request.body["parameters"].as_object().ok_or("REJECTED")?;
        if parameters.len() != 3 || request.body["parameters"]["_sys_origin_query"].as_str().is_none_or(|s| s.trim().is_empty() || s.chars().count() > 32000)
            || !config["workflowRetrieval"].as_array().ok_or("REJECTED")?.iter().any(|binding| binding["appId"] == request.body["app_id"] && binding["group"] == request.body["parameters"]["group"] && binding["person"] == request.body["parameters"]["per"]) { return Err("REJECTED".into()); }
    }
    #[cfg(test)]
    if request.operation == "qianfan.traceRetrieve" && request.body["execute_id"].as_str().is_none_or(|s| s.is_empty() || s.len() > 200) { return Err("REJECTED".into()); }
    Ok(endpoint)
}

impl Network {
    pub fn cancel_all(&self) { for (_, call) in self.0.lock().unwrap().drain() { let _ = call.cancel.send(true); } }
    pub async fn handle(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "network.open" => self.open(serde_json::from_value(params).map_err(|_| "REJECTED")?).await,
            "network.read" => self.read(params["streamId"].as_str().ok_or("REJECTED")?).await,
            "network.cancel" => {
                let attempt = params["attemptId"].as_str().ok_or("REJECTED")?;
                self.0.lock().unwrap().retain(|_, call| { if call.attempt_id == attempt { let _ = call.cancel.send(true); false } else { true } });
                Ok(json!({"cancelled":true}))
            },
            "network.close" => { if let Some(call) = self.0.lock().unwrap().remove(params["streamId"].as_str().ok_or("REJECTED")?) { let _ = call.cancel.send(true); } Ok(json!({"closed":true})) },
            _ => Err("REJECTED".into()),
        }
    }
    async fn open(&self, request: OpenRequest) -> Result<Value, String> {
        let url = endpoint(&request)?;
        let key = settings::credential(&request.connection_id).map_err(|_| "REJECTED")?;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(180)).build().map_err(|_| "REJECTED")?;
        let (cancel, mut cancelled) = watch::channel(false);
        let call = Arc::new(Call { attempt_id: request.attempt_id, cancel, body: AsyncMutex::new(Body { response: None, bytes: 0, remaining: Vec::new() }), started: Instant::now() });
        let id = uuid::Uuid::new_v4().to_string();
        { let mut calls = self.0.lock().unwrap(); if calls.len() >= 8 { return Err("REJECTED".into()); } calls.insert(id.clone(), call.clone()); }
        let result = tokio::select! {
            _ = cancelled.changed() => Err("OUTCOME_UNKNOWN".to_string()),
            response = client.post(url).bearer_auth(key).json(&request.body).send() => response.map_err(|_| "OUTCOME_UNKNOWN".to_string()),
        };
        match result {
            Ok(response) => { let status = response.status().as_u16(); call.body.lock().await.response = Some(response); Ok(json!({"status":status,"streamId":id})) },
            Err(error) => { self.0.lock().unwrap().remove(&id); Err(error) },
        }
    }
    async fn read(&self, id: &str) -> Result<Value, String> {
        let call = self.0.lock().unwrap().get(id).cloned().ok_or("OUTCOME_UNKNOWN")?;
        let mut cancelled = call.cancel.subscribe();
        if *cancelled.borrow() || call.started.elapsed() > Duration::from_secs(180) { self.0.lock().unwrap().remove(id); return Err("OUTCOME_UNKNOWN".into()); }
        let mut body = call.body.lock().await;
        if !body.remaining.is_empty() { let count = body.remaining.len().min(16384); let bytes: Vec<u8> = body.remaining.drain(..count).collect(); return Ok(json!({"done":false,"bytes":bytes})); }
        let response = body.response.as_mut().ok_or("OUTCOME_UNKNOWN")?;
        let chunk = tokio::select! {
            _ = cancelled.changed() => Err("OUTCOME_UNKNOWN"),
            value = tokio::time::timeout(Duration::from_secs(30), response.chunk()) => match value { Ok(Ok(value)) => Ok(value), _ => Err("OUTCOME_UNKNOWN") },
        };
        match chunk {
            Ok(Some(bytes)) => { body.bytes += bytes.len(); if body.bytes > 16_000_000 { self.0.lock().unwrap().remove(id); return Err("OUTCOME_UNKNOWN".into()); } let count = bytes.len().min(16384); body.remaining = bytes[count..].to_vec(); Ok(json!({"done":false,"bytes":bytes[..count].to_vec()})) },
            Ok(None) => { self.0.lock().unwrap().remove(id); Ok(json!({"done":true})) },
            Err(error) => { self.0.lock().unwrap().remove(id); Err(error.into()) },
        }
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "Explicit bounded live validation through the production credential/network boundary"]
    async fn live_provider_bridge() {
        use std::io::{BufRead, Write};
        assert_eq!(std::env::var("PCHAT_LIVE_BRIDGE").as_deref(), Ok("1"));
        let network = Network::default();
        let mut opened = 0;
        for line in std::io::stdin().lock().lines() {
            let line = line.unwrap();
            if line == "exit" { break; }
            assert!(line.len() <= 1_000_000);
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            if method == "network.open" { opened += 1; assert!(opened <= 40, "Live probe request cap reached"); }
            let result = network.handle(method, request["params"].clone()).await;
            let response = match result {
                Ok(value) => json!({"kind":"host.response","protocolVersion":2,"requestId":request["requestId"],"ok":true,"result":value}),
                Err(error) => json!({"kind":"host.response","protocolVersion":2,"requestId":request["requestId"],"ok":false,"error":error}),
            };
            println!("PCHAT_HOST_RESPONSE:{}", response);
            std::io::stdout().flush().unwrap();
        }
        network.cancel_all();
    }

    // Explicit invocation only. Exercises the production allowlist, DPAPI vault,
    // HTTP transport and stream reader without exposing credentials to Node.
    #[tokio::test]
    #[ignore = "Calls the paid DeepSeek API using the locally configured credential"]
    async fn live_deepseek_connection() {
        let directory = std::env::var_os("PCHAT_LIVE_PROBE_DIRECTORY").expect("explicit live probe required");
        let directory = std::path::PathBuf::from(directory);
        assert!(directory.is_absolute());
        let request: Value = serde_json::from_slice(&std::fs::read(directory.join("request.json")).unwrap()).unwrap();
        assert_eq!(request["operation"], "deepseek.chat");
        assert_eq!(request["body"]["thinking"], json!({"type":"disabled"}));
        assert!(request["body"]["max_tokens"].as_u64().is_some_and(|tokens| tokens <= 512));
        let network = Network::default();
        let opened = network.handle("network.open", request).await.expect("Host connection failed");
        assert_eq!(opened["status"], 200, "DeepSeek returned a non-success status");
        let stream = json!({"streamId":opened["streamId"]});
        let mut wire = Vec::<u8>::new();
        loop {
            let next = network.handle("network.read", stream.clone()).await.expect("Host stream failed");
            if next["done"] == true { break; }
            let bytes: Vec<u8> = serde_json::from_value(next["bytes"].clone()).unwrap();
            wire.extend(bytes);
            assert!(wire.len() < 1_000_000, "Live probe response too large");
        }
        std::fs::write(directory.join("response.sse"), wire).unwrap();
    }
}
