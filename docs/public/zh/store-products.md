---
title: "商店订阅商品"
description: "通过 Hands 预览和同步 Apple 与 Google 订阅商品。"
category: Release
order: 38
---

# 商店订阅商品

应用管理员可以使用已登录的用户或智能体账号，通过 JSON 文件管理自动续订订阅商品。限定为发布者的部署令牌无权执行这些价格操作。Hands 使用应用配置的 App Store Connect 凭据，或已验证并启用的 Google Play 绑定；命令行不会收到商店凭据。Apple 价格操作要求 Account Holder、Admin 或 App Manager 密钥；Google 凭据必须有权管理该应用的商品。

```sh
hands store-products apply my-ios-app --file products.json
hands store-products apply my-ios-app --file products.json --commit
hands store-products apply my-android-app --file products.json --dry-run --json
```

命令根据 Hands 应用平台选择 `apple` 或 `google`，预览完整列表，仅在使用 `--commit` 时写入。每个商品单独同步，遇到第一个失败即停止。商店操作不是事务：先前步骤可能已经完成。输出会列出这些步骤；待处理不代表成功。失败后重试前，请重新读取商店状态。

两个平台均适用的最小示例文件如下，不包含价格：

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

请选择适合应用的本地化商品详情；Google 要求包含应用默认语言对应的条目。商品 ID 和基本方案周期创建后不能修改。Apple 的 `groupLevel` 为 1 时是最高等级；相同服务等级的商品可以共享同一等级。Hands 会保留文件中未列出的本地化内容和方案。已有 Apple 商品若属于其他订阅组，操作会被拒绝。

省略价格会保留现有价格。要设置 Apple 价格，请在商品中添加 `prices`，例如：

```json
"prices": [{ "territory": "USA", "customerPrice": "4.99", "preserveCurrentPrice": true }]
```

价格是以地区货币表示的十进制字符串。Hands 会查找完全匹配的 Apple 价格点，拒绝不可用或有歧义的价格点，也不会覆盖已安排的价格变更。每个地区都必须显式选择 `preserveCurrentPrice`。新商品在 Apple 创建之前没有价格点，因此预览会将其标记为延后，无法在创建前验证。Hands 使用 Apple 的 `UPFRONT` 计费方案：每个月度或年度订阅周期开始时支付整个周期的价格，而不是对年度承诺按月分期。价格变更可能影响客户，生效后可能无法撤销；提交前请检查商店方案。

要设置 Google 地区价格，请为每个基本方案添加 `regionalConfigs`：

```json
"regionalConfigs": [{
  "regionCode": "US", "newSubscriberAvailability": true,
  "price": { "currencyCode": "USD", "units": "4", "nanos": 990000000 }
}]
```

示例仅用于说明，并非推荐价格。未列出的地区保持不变。请求激活时，至少要有一个有价格且可用的地区。Hands 不会停用方案，也不会迁移现有订阅者的价格分组。Google 在激活前可能要求额外配置税务、地区或账号。

Apple 商品也可指定 `"reviewScreenshot": "review.png"`，路径相对于 JSON 文件。使用不超过 5 MiB 的 PNG 或 JPEG。Hands 会比较图像校验和，必要时预留并上传替换图片，在后续运行中等待 Apple 报告处理完成。上传待处理或缺少 Google 价格时，命令行会以非零状态退出。

Google 预览失败时会返回适配器定义的错误类别，以及 Google 错误响应中的数字 HTTP 状态码（如果有）。对于格式错误的成功响应，还可能包含状态码以及响应体为空或已解析为 JSON 的信息。输出不包含服务商错误文本或凭据。错误类别为 `play_token_rejected` 时，请重新连接 Google 账号；`play_api_rejected` 则需要检查账号对应用的权限或 Google API 响应。

如果第一次读取 Google 订阅列表得到不含响应体的 HTTP 204，预览会假定目录为空，并标记 `assumed_empty_unverified` 和待处理结果。这不能证明现有商品不存在。命令行不会提交不完整的预览，服务端在初始目录读取返回 204 时也会拒绝写入。重试前请确认目录并调查该响应；写入后的失败仍需按恢复流程处理。

Hands 只管理此处列出的字段，不会创建优惠、税务信息、银行信息或商店协议。Hands 之外的商店变更可能与同步操作竞争；请检查预览并避免同时修改商店控制台。商店写入结果不确定时，Hands 会保留应用锁而不自动重试。操作人员必须先检查服务商状态，按照[恢复手册](https://github.com/botiverse/hands/blob/main/docs/runbooks/store-product-recovery.md)处理，再进行下一次提交。
