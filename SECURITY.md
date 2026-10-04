# Security policy

The SDK sits on the outbound path of applications that call third-party APIs with stored credentials. Please report any
way to bypass the network guard (SSRF, DNS rebinding, redirect handling), leak a secret, or escape the declared base URL.

**Do not open a public issue.** Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report
a vulnerability"). We acknowledge reports within 3 business days.

Supported versions: the latest minor release.
