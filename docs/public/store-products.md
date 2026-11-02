---
title: Store subscription products
description: Preview and reconcile Apple and Google subscription products through Hands.
category: Release
order: 38
---

# Store subscription products

An app admin can manage auto-renewing subscription products with a JSON file using a signed-in human or agent account. Publisher-scoped deploy tokens do not have access to these pricing operations. The app's configured App Store Connect credential or verified, enabled Google Play binding is used; the CLI never receives store credentials. Apple requires an Account Holder, Admin, or App Manager key for prices. Google requires a Play credential allowed to manage the app's products.

```sh
hands store-products apply my-ios-app --file products.json
hands store-products apply my-ios-app --file products.json --commit
hands store-products apply my-android-app --file products.json --dry-run --json
```

The command selects `apple` or `google` from the Hands app platform, previews the complete list, and writes only with `--commit`. Each product is reconciled separately and the command stops at the first failure. A store operation is not a transaction: earlier steps can already have completed. The output lists those steps, and a pending result is not success. Re-read the store before retrying after a failure.

A minimal file for both platforms, with no prices, is:

```json
{
  "apple": {
    "group": {
      "referenceName": "Example Pro",
      "localizations": [{ "locale": "en-US", "name": "Example Pro" }]
    },
    "products": [{
      "productId": "example.pro.monthly",
      "name": "Example Pro Monthly",
      "subscriptionPeriod": "ONE_MONTH",
      "groupLevel": 1,
      "localizations": [{ "locale": "en-US", "name": "Example Pro", "description": "Pro membership" }]
    }]
  },
  "google": {
    "regionsVersion": "2022/02",
    "products": [{
      "productId": "example.pro",
      "listings": [{ "languageCode": "en-US", "title": "Example Pro", "description": "Pro membership" }],
      "basePlans": [
        { "basePlanId": "monthly", "billingPeriodDuration": "P1M", "activate": true },
        { "basePlanId": "annual", "billingPeriodDuration": "P1Y", "activate": true }
      ]
    }]
  }
}
```

Choose the localized listings for your app; Google requires an entry for the parent app's default language. Product IDs and base-plan periods are immutable. Apple `groupLevel` 1 is the highest tier; products with the same service level may share a level. Hands preserves localizations and plans that are not named in the file. Existing Apple products in a different group are rejected.

Omitting prices leaves existing prices alone. To set Apple prices, add `prices` to a product, for example:

```json
"prices": [{ "territory": "USA", "customerPrice": "4.99", "preserveCurrentPrice": true }]
```

Prices are decimal strings in the territory's currency. Hands looks up the exact Apple price point, refuses unavailable or ambiguous points, and refuses to overwrite a scheduled change. `preserveCurrentPrice` must be chosen explicitly for each territory. A new product has no price points until Apple creates it, so preview marks them deferred and cannot validate them before creation. Hands uses Apple's `UPFRONT` billing plan type: the whole price is paid at the start of each monthly or annual subscription period, rather than a monthly installment on an annual commitment. Price changes can affect customers and can be irreversible once effective; review the store plan before committing.

To set Google regional prices, add `regionalConfigs` to each base plan:

```json
"regionalConfigs": [{
  "regionCode": "US", "newSubscriberAvailability": true,
  "price": { "currencyCode": "USD", "units": "4", "nanos": 990000000 }
}]
```

The example is illustrative, not a recommended price. Unlisted regions stay unchanged. A requested activation waits for at least one available region with a price. Hands does not deactivate plans or migrate existing subscribers' price cohorts. Google may require additional tax, region, or account configuration before activation.

An Apple product can also specify `"reviewScreenshot": "review.png"`; the path is relative to the JSON file. Use a PNG or JPEG at most 5 MiB. Hands compares the image checksum, reserves and uploads a replacement if needed, and waits for Apple to report processing complete on a later run. A pending upload or missing Google price produces a nonzero CLI exit status.

Only the fields shown here are managed. No offers, tax information, bank details, or store agreements are created. Provider changes made outside Hands can race with a reconciliation; review the preview and avoid concurrent console changes. An uncertain store write retains its per-app lock rather than automatically retrying. An operator must inspect the provider and follow the [recovery runbook](https://github.com/botiverse/hands/blob/main/docs/runbooks/store-product-recovery.md) before another commit.
