# Security policy

## Secret handling

- Never commit live secrets, private keys, production `.env` files or raw private contact datasets.
- CI performs a high-confidence committed-secret pattern scan; platform-native secret scanning should also be enabled where available.
- Runtime credentials belong in environment/provider secret stores and must be scoped by service/environment/tenant capability.

## Suspected credential exposure

1. Disable/revoke the credential immediately at the provider.
2. Issue a replacement with the narrowest required scope.
3. Remove the secret from current source and, where appropriate, repository history.
4. Review provider/GitHub/audit logs for misuse.
5. Record the incident, affected tenant/system, time window and corrective actions.
6. Do not restore autonomous publishing until the blast radius is understood.

## Publication incident

Use the global autonomous-publishing kill switch for AI publication incidents. Public read availability must remain independent of that switch. Retractions/corrections require immutable audit evidence and channel/cache propagation once those adapters are implemented.
