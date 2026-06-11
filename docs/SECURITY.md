# Security Policy

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| >= 1.0.0 | :white_check_mark: |

## Design Notes

All user-provided values are passed to `xcrun simctl` and `idb` through `execFile` with argument arrays (never through a shell), and positional arguments are separated from options with `--`. Inputs are validated with Zod schemas before any command is constructed.

This package descends from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp), which fixed a command injection vulnerability in its v1.3.3 by replacing string-interpolated `exec` calls with `execFile` argument arrays. That hardened command construction is preserved here.

## Reporting a Vulnerability

To report a security issue, please use the GitHub Security Advisory "Report a Vulnerability" tab on [the repository](https://github.com/Tahul/ios-simulator-mcp).

You can expect an initial response within 48 hours. If the vulnerability is accepted, a fix will be coordinated with you along with the disclosure timeline, and you will be credited for the discovery unless you prefer to remain anonymous.
