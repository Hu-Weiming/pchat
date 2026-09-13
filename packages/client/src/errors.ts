export class ClientError extends Error {
  constructor(readonly code: "PROTOCOL_ERROR" | "INVALID_INPUT" | "UNAVAILABLE") {
    super(code === "PROTOCOL_ERROR" ? "The runtime response is incompatible. Reconnect to refresh the current state." : code === "INVALID_INPUT" ? "The request is invalid." : "The runtime is unavailable. Refresh its current state before retrying.");
    this.name = "ClientError";
  }
}
