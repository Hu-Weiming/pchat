use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, ptr};
use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB}};

pub fn state_directory() -> PathBuf {
    std::env::var_os("PCHAT_DEV_ROOT").map(PathBuf::from).filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"D:\Dev")).join("state").join("pchat")
}

fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    let source = CRYPT_INTEGER_BLOB { cbData: bytes.len().try_into().map_err(|_| "凭证过长")?, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
    // DPAPI binds the blob to this Windows user. Output belongs to LocalAlloc.
    let result = unsafe { if decrypt {
        CryptUnprotectData(&source, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    } else {
        CryptProtectData(&source, ptr::null(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    } };
    if result == 0 { return Err("Windows 凭证保护失败".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput { provider: String, api_key: String, model_id: Option<String>, window_tokens: u64, max_output_tokens: u64 }

pub fn configuration() -> Result<Value, String> {
    let path = state_directory().join("configuration.json");
    if !path.exists() { return Ok(json!({"version":1,"connections":[],"models":[],"roles":[],"retrieval":[],"maxCostUnits":100})); }
    let bytes = fs::read(path).map_err(|_| "配置读取失败")?;
    serde_json::from_slice(&bytes).map_err(|_| "配置格式损坏，请保留现有文件并检查备份".into())
}

fn write_private(name: &str, bytes: &[u8]) -> Result<(), String> {
    let directory = state_directory();
    fs::create_dir_all(&directory).map_err(|_| "无法创建数据目录")?;
    let temporary = directory.join(format!("{}.{}.tmp", name, uuid::Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|_| "写入失败")?;
    fs::rename(temporary, directory.join(name)).map_err(|_| "保存失败".into())
}

pub fn save_connection(input: ConnectionInput) -> Result<(), String> {
    if !["deepseek", "qianfan"].contains(&input.provider.as_str()) || input.api_key.is_empty() || input.api_key.len() > 4096 || !input.api_key.bytes().all(|b| (33..=126).contains(&b)) { return Err("服务或密钥格式无效".into()); }
    if input.provider == "deepseek" && (input.model_id.as_ref().is_none_or(|id| id.is_empty() || id.len() > 200) || input.window_tokens < 2048 || input.window_tokens > 2_000_000 || input.max_output_tokens < 256 || input.max_output_tokens >= input.window_tokens || input.max_output_tokens > 128_000) { return Err("模型参数无效".into()); }
    let id = format!("{}-personal", input.provider);
    let encrypted = crypt(input.api_key.as_bytes(), false)?;
    write_private(&format!("{}.vault", id), &encrypted)?;
    let mut config = configuration()?;
    let revision = uuid::Uuid::new_v4().to_string();
    let connections = config["connections"].as_array_mut().ok_or("连接配置无效")?;
    connections.retain(|item| item["id"] != id);
    connections.push(json!({"id":id,"provider":input.provider,"revision":revision}));
    if input.provider == "deepseek" {
        config["models"].as_array_mut().ok_or("模型配置无效")?.push(json!({"binding":{"connectionId":id,"modelId":input.model_id,"configRevision":revision},"windowTokens":input.window_tokens,"maxOutputTokens":input.max_output_tokens}));
    }
    write_private("configuration.json", &serde_json::to_vec_pretty(&config).map_err(|_| "配置编码失败")?)
}

pub fn credential(connection_id: &str) -> Result<String, String> {
    if !["deepseek-personal", "qianfan-personal"].contains(&connection_id) { return Err("未知连接".into()); }
    let bytes = fs::read(state_directory().join(format!("{}.vault", connection_id))).map_err(|_| "请先填写密钥")?;
    String::from_utf8(crypt(&bytes, true)?).map_err(|_| "凭证读取失败".into())
}

pub fn connection_options() -> Result<Value, String> {
    let config = configuration()?;
    let connections = config["connections"].as_array().ok_or("连接配置无效")?;
    let models: Vec<Value> = config["models"].as_array().ok_or("模型配置无效")?.iter().filter(|model| connections.iter().any(|connection| connection["id"] == model["binding"]["connectionId"] && connection["revision"] == model["binding"]["configRevision"]))
        .map(|model| json!({"label":model["binding"]["modelId"],"binding":model["binding"],"ready":true})).collect();
    let retrieval: Vec<Value> = connections.iter().filter(|connection| connection["provider"] == "qianfan").map(|connection| json!({"label":"百度千帆","connectionId":connection["id"],"readyCorpusIds":config["retrieval"].as_array().unwrap_or(&vec![]).iter().filter_map(|item| item["binding"]["corpusId"].as_str()).collect::<Vec<_>>()})).collect();
    Ok(json!({"models":models,"retrieval":retrieval}))
}

#[cfg(test)] mod tests {
    use super::crypt;
    #[test] fn protects_and_recovers_a_credential_without_plaintext_storage() {
        let secret = b"test-only-credential-not-a-real-key";
        let encrypted = crypt(secret, false).unwrap();
        assert!(!encrypted.windows(secret.len()).any(|part| part == secret));
        assert_eq!(crypt(&encrypted, true).unwrap(), secret);
    }
}
