# Lifecycle safety and recovery

The existing install/update/uninstall paths remain the owners of Forge lifecycle behavior. The adaptive layer adds a small plan/receipt contract for workspace selection and does not invoke untrusted commands.

The Cycle 15 audit identified mutation-order risks in the older local-source path. The route now validates identity, source gates, Python compatibility and executable setup before provisioning or deleting managed artifacts; update also checks the registered source snapshot before reconciliation, and uninstall acquires the lifecycle lock before backup/removal. Receipt/state writes remain atomic. The remaining limitation is that a failed external bootstrap is reported as incomplete and requires an explicit repair; the implementation does not pretend that a shell script can be rolled back transactionally.
