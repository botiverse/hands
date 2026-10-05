---
title: "Google Play Authorization"
description: "通过 Google 授权连接 Play：创建 Web 客户端、配置、验证和撤销，无需服务账号密钥。"
category: "Console"
order: 7
---

# Connect Google Play

Connect your Google account to publish an Android app through Hands. You do not need a service-account JSON key.

## Before you connect

You need administrator access to your app in Hands and a Google account with access to the same app in Google Play Console. The app must already exist in Play Console. Your Google account needs permission for the testing or production tracks you plan to use.

## Connect your account

1. Open your Android app in Hands and select **Integrations** in the left sidebar.
2. Find **Google Play** and click **Connect**.
3. Sign in to the Google account that has access to your Play app, then approve the requested access.
4. When you return to Hands, expand Google Play to finish setup. A connected account can show **Needs configuration** until you save the app settings.

## Choose your app and tracks

1. Select your app's Android package name. Hands suggests package names from your uploaded Android builds; you can also enter it manually. It must match the app in Play Console.
2. Hands loads the available Play tracks for that package. Choose your internal testing, closed testing and production tracks. If you have multiple closed testing tracks, select the one you intend to use, such as alpha or beta.
3. Click **Save**. Hands checks the connection and enables it when validation succeeds.

Connecting and saving settings do not upload or publish a release. You can use **Test connection** to check access again without publishing.

## Publish a build

Prepare a signed Android App Bundle (AAB) for your Play app. Complete your normal build review and acceptance, then explicitly submit the release to the intended track through Hands. Start with internal testing to verify the build before broader distribution. A publisher with the app's publishing permission can submit; this can be a person or an agent.

Use a new version code for each new build. Your first upload can use your app's existing version-number scheme; it does not need to start at 1. Google Play may require additional app setup or review before accepting a release.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Connect is unavailable because Google authorization is not configured | Contact your Hands administrator to enable the Google Play integration on this server. |
| Google refuses access | Confirm you signed in to the account that has access to your app in Play Console. Follow any access or verification instructions shown by Google. |
| You return to Hands but the connection fails | Check the error shown next to Google Play and click Connect to try again. |
| The track list cannot load | Check the package name and your Google account's app permissions, then refresh the tracks. If the error includes SERVICE_DISABLED, ask your Hands administrator to enable the Google Play API for this integration. |
| The account is connected but still needs configuration | Expand Google Play, choose the package name and tracks, and save. |
| A previously working connection stops working | Try Test connection. Reconnect if Google access has expired or been revoked. |

## Disable or disconnect

**Disable** stops publishing through this connection while keeping its settings for later use.

**Unbind** removes this app's saved Google Play connection from Hands. To revoke access to the Google account itself, visit [Google account connections](https://myaccount.google.com/connections) and remove the associated application. This can affect other Hands apps using the same Google account and connection.
