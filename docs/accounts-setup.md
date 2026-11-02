# Setting up optional accounts

Accounts are off by default. With no config, the site has no sign-in UI, holds no Firebase code and makes no third-party request. Nothing in AgentOnTrack requires an account. These steps are for the site's owner only. They have not yet been done on a real Firebase project.

## 1. Create the Firebase project

1. At <https://console.firebase.google.com>, create a project. Decline Google Analytics, since the site promises none.
2. Check it is on the free Spark plan. Do not add a billing account. On Spark, going over a quota makes requests fail, instead of costing money.
3. Under **Build > Firestore Database**, create a database in production mode.

## 2. Turn on Google sign-in

1. Under **Build > Authentication > Sign-in method**, enable the **Google** provider and set a support email.
2. Under **Authentication > Settings > Authorized domains**, add `pandeysatyam.com`.

## 3. Deploy the rules

From a checkout, with `firebase-tools` available and logged in:

```
firebase deploy --only firestore:rules --project <your-project-id>
```

Before that, Firestore refuses every request from the site. `firestore.rules` and `firebase.json` are at the root of the repository.

## 4. Set the config

Under **Project settings > General > Your apps**, add a web app, and copy its config object as JSON with at least `apiKey`, `authDomain`, `projectId` and `appId`. These values identify the project and are visible to every visitor once published. Access is controlled by the rules, so they are not secrets, but keep them out of the repository anyway, so that the default build stays without accounts.

Set the JSON, on one line, when building the site:

```
NEXT_PUBLIC_FIREBASE_CONFIG='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}' pnpm build:pages
```

`scripts/build-pages.mjs` passes it to the dashboard as `VITE_FIREBASE_CONFIG`, and refuses to build if it is not valid JSON with those fields. For GitHub Pages, keep it in a repository variable named `FIREBASE_WEB_CONFIG`, which the public `pages.yml` workflow passes to the build. An unset variable builds the site with no accounts.

## 5. Check it

- Sign in at `/account/`. Your name and email appear.
- Send feedback at `/feedback/`. The document appears in the `feedback` collection in the console, which is where you read it.
- Export, then delete your account, and check that its documents are gone.

## What to know

- **Feedback is open to anyone**, so it can be spammed, up to Firestore's free quota, after which writes fail until the next day. The rules limit each document's fields and length, but not the number of documents. Firebase App Check would reduce this, and is not set up here.
- **Reading feedback** is only possible in the Firebase console. No client can read it.
- **Deleting anonymous feedback** is only possible in the console, since it is not linked to anyone. Honour such requests there.
- **The privacy page** changes by itself when the config is set. Have it reviewed before turning accounts on.

## Testing

`e2e/accounts.spec.ts` runs against the Firebase emulators, in the `accounts` job of `.github/workflows/ci.yml`. It needs Java, and it skips unless `FIREBASE_AUTH_EMULATOR_HOST` is set.
