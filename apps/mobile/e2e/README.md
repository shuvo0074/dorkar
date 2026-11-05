# Journeys

[Maestro](https://maestro.dev) flows, run against a dev build with the backend up and seeded.
`e2e/run.sh <app id>` runs them in order, e.g. `e2e/run.sh com.dorkar.wallet`. The sign-in code comes from
`var/dev-sms.log`; `SMS_LOG` overrides that path.
