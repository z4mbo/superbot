use std::time::Duration;

use url::Url;

use crate::T3Error;

const LOOPBACK: [&str; 3] = ["127.0.0.1", "[::1]", "localhost"];

pub(crate) const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn is_loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| LOOPBACK.contains(&host))
}

/// The T3 MCP endpoint the operator pasted: HTTPS, or HTTP on this computer, with path `/mcp`
/// and nothing else that could carry a credential or redirect.
pub fn mcp_endpoint(input: &str) -> Result<Url, T3Error> {
    let url = Url::parse(input.trim()).map_err(|_| T3Error::InvalidEndpoint)?;
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url));
    if !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/mcp"
    {
        return Err(T3Error::InvalidEndpoint);
    }
    Ok(url)
}

/// Every T3 request leaves only for the configured origin and never follows a redirect.
#[derive(Clone)]
pub(crate) struct Http {
    client: reqwest::Client,
    origin: url::Origin,
}

impl Http {
    pub fn new(endpoint: &Url) -> Result<Self, T3Error> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(TIMEOUT)
            .user_agent(concat!("superbot-t3-inbox/", env!("CARGO_PKG_VERSION")));
        if is_loopback(endpoint) {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder.build().map_err(|_| T3Error::Unreachable(endpoint.origin().ascii_serialization()))?,
            origin: endpoint.origin(),
        })
    }

    pub fn same_origin(&self, url: &Url) -> Result<(), T3Error> {
        if url.origin() != self.origin || !url.username().is_empty() || url.password().is_some() {
            return Err(T3Error::OtherOrigin);
        }
        Ok(())
    }

    pub fn request(&self, method: reqwest::Method, url: &Url) -> Result<reqwest::RequestBuilder, T3Error> {
        self.same_origin(url)?;
        Ok(self.client.request(method, url.clone()))
    }

    pub fn unreachable(&self) -> T3Error {
        T3Error::Unreachable(self.origin.ascii_serialization())
    }
}

#[cfg(test)]
mod tests {
    use super::mcp_endpoint;

    #[test]
    fn only_https_or_loopback_mcp_paths_are_accepted() {
        assert!(mcp_endpoint("http://127.0.0.1:3773/mcp").is_ok());
        assert!(mcp_endpoint(" https://t3.example.com/mcp ").is_ok());
        assert!(mcp_endpoint("http://[::1]:3773/mcp").is_ok());
        for refused in [
            "http://t3.example.com/mcp",
            "https://t3.example.com/",
            "https://t3.example.com/mcp?token=1",
            "https://t3.example.com/mcp#x",
            "https://user:secret@t3.example.com/mcp",
            "file:///mcp",
            "not a url",
        ] {
            assert!(mcp_endpoint(refused).is_err(), "{refused}");
        }
    }
}
