# Product usage data

The T3 Code server sends product usage events to J5 Code's own PostHog project,
associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects.
Events include the provider, model, reasoning effort, permission mode, turn result, duration,
release channel, and main-agent token totals when available. They also name the features you use
and the tools agents call, without paths, IDs, or text. Each turn that starts is also
reported with who asked for it (you, an agent, or the server itself), whether a scheduled task
started it, and whether the thread is a seat in a Crew. When an ask between participants ends, the
event says how it ended, what kind of participant was on each side, its urgency, and how long it
was open. A playbook run reports its step count when it starts, and the step it reached when it
completes or is cancelled. A Crew reports the number of seats asked for, approved and changed when
you decide on its roster, and how many seats started when it launches. Every fifteen minutes the
server reports counts of working threads, live Crews and waiting asks.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

Builds that set a relay trace destination also send relay connection traces to Axiom to diagnose
T3 Connect connectivity. J5 Code's releases set none.

To disable product events and relay tracing, set `T3CODE_TELEMETRY_ENABLED=false` in the server's
environment before starting it. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`j5` CLI opens, does not read these variables.

To label your own events, for example while testing a build, set `J5CODE_TELEMETRY_TAG` to a
short label of your choice in the server's environment. The label is sent with every event. It is
not read from your shell profile by the desktop app.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
