use super::{Engine, Error};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

const MAX_FRAME: usize = 4 * 1024 * 1024;
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const TURN_TIMEOUT: Duration = Duration::from_secs(180);

pub(super) struct Wire {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    line: Vec<u8>,
    next_id: u64,
    pending: bool,
    work: TempDir,
}

impl Wire {
    pub(super) fn launch(engine: &Engine) -> Result<Self, Error> {
        let work = tempfile::tempdir().map_err(|_| Error::Start)?;
        let mut child = engine
            .command(work.path())?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Error::Start)?;
        let stdin = child.stdin.take().ok_or(Error::Start)?;
        let stdout = BufReader::new(child.stdout.take().ok_or(Error::Start)?);
        Ok(Self {
            child,
            stdin,
            stdout,
            line: Vec::new(),
            next_id: 0,
            pending: false,
            work,
        })
    }

    pub(super) fn cwd(&self) -> &std::path::Path {
        self.work.path()
    }

    pub(super) async fn write(&mut self, frame: Value) -> Result<(), Error> {
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| Error::Protocol)?;
        if bytes.len() >= MAX_FRAME {
            return Err(Error::Limit);
        }
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|_| Error::Closed)
    }

    pub(super) async fn read(&mut self) -> Result<Value, Error> {
        loop {
            let buf = self.stdout.fill_buf().await.map_err(|_| Error::Closed)?;
            if buf.is_empty() {
                return Err(Error::Closed);
            }
            let newline = buf.iter().position(|byte| *byte == b'\n');
            let count = newline.map_or(buf.len(), |index| index + 1);
            if self.line.len() + count > MAX_FRAME {
                return Err(Error::Limit);
            }
            self.line.extend_from_slice(&buf[..count]);
            self.stdout.consume(count);
            if newline.is_some() {
                let frame = serde_json::from_slice(&self.line).map_err(|_| Error::Protocol);
                self.line.clear();
                return frame;
            }
        }
    }

    pub(super) async fn acp(
        &mut self,
        method: &str,
        params: Value,
        duration: Duration,
        mut notify: impl FnMut(&Value) -> Result<(), Error>,
    ) -> Result<Value, Error> {
        if self.pending {
            return Err(Error::Closed);
        }
        self.pending = true;
        self.next_id += 1;
        let id = self.next_id;
        let result = timeout(duration, async {
            self.write(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})).await?;
            loop {
                let frame = self.read().await?;
                if frame["jsonrpc"] != "2.0" {
                    return Err(Error::Protocol);
                }
                if let Some(method) = frame["method"].as_str() {
                    match frame.get("id") {
                        Some(id) if method == "session/request_permission" => {
                            self.write(json!({"jsonrpc":"2.0", "id":id, "result":{"outcome":{"outcome":"cancelled"}}})).await?;
                        }
                        Some(id) => {
                            self.write(json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32601, "message":"Method not supported"}})).await?;
                        }
                        None => notify(&frame)?,
                    }
                    continue;
                }
                if frame["id"].as_u64() != Some(id) {
                    return Err(Error::Protocol);
                }
                if let Some(error) = frame.get("error") {
                    return Err(Error::Remote(error["code"].as_i64().ok_or(Error::Protocol)?));
                }
                return frame.get("result").cloned().ok_or(Error::Protocol);
            }
        }).await.unwrap_or(Err(Error::Timeout));
        if result.is_ok() || matches!(result, Err(Error::Remote(_))) {
            self.pending = false;
        } else {
            self.terminate();
        }
        result
    }

    pub(super) async fn request(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        self.acp(method, params, REQUEST_TIMEOUT, |_| Ok(())).await
    }

    pub(super) fn terminate(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub(super) async fn run_command(mut command: Command, duration: Duration) -> Result<String, Error> {
    timeout(duration, async {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Error::Start)?;
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or(Error::Start)?
            .take((MAX_FRAME as u64) + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| Error::Closed)?;
        if output.len() as u64 > (MAX_FRAME as u64) {
            return Err(Error::Limit);
        }
        if !child.wait().await.map_err(|_| Error::Closed)?.success() {
            return Err(Error::Remote(0));
        }
        String::from_utf8(output).map_err(|_| Error::Protocol)
    })
    .await
    .unwrap_or(Err(Error::Timeout))
}
