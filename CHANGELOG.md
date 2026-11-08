# Changelog

## [0.5.1](https://github.com/JinhuW/reddit_marketing/compare/v0.5.0...v0.5.1) (2026-11-08)


### Bug Fixes

* **worker:** re-send proxy credentials to browsers a restarted node agent adopts ([d6a0d51](https://github.com/JinhuW/reddit_marketing/commit/d6a0d51df4d90cf91ebf8f69091e8e765fe9ad7f))

## [0.5.0](https://github.com/JinhuW/reddit_marketing/compare/v0.4.0...v0.5.0) (2026-11-08)


### Features

* **browsers:** create standalone browsers and assign an account to one ([6e3a682](https://github.com/JinhuW/reddit_marketing/commit/6e3a6829b618f67075be1e1f7d7af5277eb7b096))

## [0.4.0](https://github.com/JinhuW/reddit_marketing/compare/v0.3.0...v0.4.0) (2026-11-08)


### Features

* **node:** run a second browser node on the same host ([c81ff24](https://github.com/JinhuW/reddit_marketing/commit/c81ff24d3a66e18763fee6baa241afced701083f))


### Bug Fixes

* **browsers:** keep the in-use saved proxy visible after "Use" and re-seed the manual form ([e715f68](https://github.com/JinhuW/reddit_marketing/commit/e715f685b11ad77df0a6276cab1a33873cfda5eb))

## [0.3.0](https://github.com/JinhuW/reddit_marketing/compare/v0.2.0...v0.3.0) (2026-11-08)


### Features

* **browsers:** fold the per-profile proxy form away by default ([dfd46d9](https://github.com/JinhuW/reddit_marketing/commit/dfd46d9400bd6d041c624f3e73a966c4aec317ef))

## [0.2.0](https://github.com/JinhuW/reddit_marketing/compare/v0.1.1...v0.2.0) (2026-11-08)


### Features

* **accounts:** let one person own several Reddit accounts ([7c4a957](https://github.com/JinhuW/reddit_marketing/commit/7c4a957d8b9fc7c230208d0f40f793f1fd996538))

## [0.1.1](https://github.com/JinhuW/reddit_marketing/compare/v0.1.0...v0.1.1) (2026-11-08)


### Bug Fixes

* **accounts:** resume an unfinished browser connect instead of refusing a new one ([8be76af](https://github.com/JinhuW/reddit_marketing/commit/8be76af5221018f8af27f75a7fb17628dec9bb93))

## 0.1.0 (2026-11-08)


### Features

* **accounts:** browser-mode data and protocol foundation ([b969c56](https://github.com/JinhuW/reddit_marketing/commit/b969c56e47a146b6e23be1ce25c805216eb3791f))
* **browser-profile:** CloakBrowser image with seeded fingerprint and probe ([07aaff7](https://github.com/JinhuW/reddit_marketing/commit/07aaff79c7199e59f6f448b4d72f96b72e2a21fe))
* **browsers:** sync the clipboard both ways in the live browser view by default ([d21d51b](https://github.com/JinhuW/reddit_marketing/commit/d21d51b89b94c95fe8a2b0f916830d2ca40ef590))
* **gateway:** authenticated websocket hub for browser nodes ([6138ebf](https://github.com/JinhuW/reddit_marketing/commit/6138ebfc9e722e397d63e30a53622cacc60d7bbd))
* **gateway:** dispatch browser jobs to nodes behind the approval gate ([bef9d37](https://github.com/JinhuW/reddit_marketing/commit/bef9d3785904b777f412704d098b0aad3be87820))
* **gateway:** VNC relay over the agent's outbound socket ([cf17d58](https://github.com/JinhuW/reddit_marketing/commit/cf17d5814c268bc4f9497b3fa056baa02fa8b2af))
* **home,opportunities:** Home dashboard and Opportunities screen on real data ([9a59cc8](https://github.com/JinhuW/reddit_marketing/commit/9a59cc8b04f1f1b412f85220c76ae3e4dbd4ff82))
* **m0:** monorepo scaffold, Prisma schema and seed, guardrail rules, auth and app shell ([1c0ccca](https://github.com/JinhuW/reddit_marketing/commit/1c0ccca2f41bc3ae7242cbcd9495894dc0f9c09e))
* **node-agent:** comment, DM and proxy test actions over CDP ([0d81202](https://github.com/JinhuW/reddit_marketing/commit/0d81202ae689d21aab19830e3e5ee636ed41f64e))
* **node-agent:** gateway client with reconnect and command dispatch ([f265a8b](https://github.com/JinhuW/reddit_marketing/commit/f265a8b6e3f5804c4ba0cdfefd130fd2022d4b03))
* **node-agent:** per-profile containers through the local docker socket ([8fa2b25](https://github.com/JinhuW/reddit_marketing/commit/8fa2b25c22ccfade18d5e46cfd2f0d50a15a4d31))
* **node-agent:** profile.whoami ([aeed050](https://github.com/JinhuW/reddit_marketing/commit/aeed050c0de7e12f1debd67c917112187fb2e77d))
* **ops:** add-proxy CLI for workspace proxies ([4f077f4](https://github.com/JinhuW/reddit_marketing/commit/4f077f44733f9ebc4c1d493331a9fcb06fe34712))
* **ops:** browser node install and deploy ([2a76746](https://github.com/JinhuW/reddit_marketing/commit/2a767460d46e7269fa507f5fe09728547c2ea4b3))
* **ops:** nightly off-Railway postgres dump ([a8922b0](https://github.com/JinhuW/reddit_marketing/commit/a8922b09e35aef6f2f433c2548e4769aa003b207))
* **ops:** register-node CLI for production browser nodes ([c0e976e](https://github.com/JinhuW/reddit_marketing/commit/c0e976e11685d686bfd80437568d9a31fb6352cb))
* **shared:** browser node contracts, schema and repos ([5dd1bb4](https://github.com/JinhuW/reddit_marketing/commit/5dd1bb4119f5bfd8f4ae4c34c4d3eb6814ce7c0a))
* **web:** authenticated VNC websocket proxy ([9c0c9b1](https://github.com/JinhuW/reddit_marketing/commit/9c0c9b1efb7c8439d3f1bbeed512c3ddbeb20403))
* **web:** connect through the browser; browsers node status and controls ([4a0bea1](https://github.com/JinhuW/reddit_marketing/commit/4a0bea1d9a1c7dcaed53f668f1d487f6d1ef0f77))
* **web:** every screen on real data; drafts repo with the approval gate ([37919e5](https://github.com/JinhuW/reddit_marketing/commit/37919e57c920c690f89bdb3d7e36075370c2ba6f))
* **worker:** browser fallback, idle stop and node health ([04063a6](https://github.com/JinhuW/reddit_marketing/commit/04063a66f43ac85c144eabbdcd9ccc616a04a88c))
* **worker:** browser-mode posting, polling and whoami ([124d591](https://github.com/JinhuW/reddit_marketing/commit/124d5913576ad86d73c6b99b7aefec7a9724027a))
* **worker:** draft.generate and post.publish wired to the approval gate ([d923771](https://github.com/JinhuW/reddit_marketing/commit/d92377191d0e361274072902ea69840406b36ca7))
* **worker:** queues, Reddit client, agent runtime, tracking endpoints, infra and docs ([3ae65cc](https://github.com/JinhuW/reddit_marketing/commit/3ae65ccf5207634dd2b17b1fce70e76016af912e))
* **worker:** service roles for core and gateway ([4187dec](https://github.com/JinhuW/reddit_marketing/commit/4187decf90ca998a4d1d8c9098cdd451246c2383))


### Bug Fixes

* **browsers:** answer proxy auth for every tab from launch ([8460ca2](https://github.com/JinhuW/reddit_marketing/commit/8460ca2f87837bc02413c17fbcc9f78e4fcde85c))
* **browsers:** one shared VNC URL signature for web and gateway; single-tag browser locale ([1a110c2](https://github.com/JinhuW/reddit_marketing/commit/1a110c2ff33ca9c63efef1c70b3e310b2f5d6833))
* **browsers:** skip a browser job still in flight; clearer sign-in check failures ([288e20c](https://github.com/JinhuW/reddit_marketing/commit/288e20c1537d368c3f6f23796b008a1493badd85))
* **db:** make browser node names unique across workspaces ([15a57f3](https://github.com/JinhuW/reddit_marketing/commit/15a57f3320fa6dc1d945bd2040618824c0767bea))
* **gateway:** mount dispatch, VNC relay and health plugins in the gateway role ([6fdb9fe](https://github.com/JinhuW/reddit_marketing/commit/6fdb9fe51010cc75a737f6875a3300fec87e9a27))
* integrate Wave 1 ([f46cf3f](https://github.com/JinhuW/reddit_marketing/commit/f46cf3f588fe97d771a087ac72ecedea5c3ad3a9))
* integrate Wave 2 ([c9fdc27](https://github.com/JinhuW/reddit_marketing/commit/c9fdc27df6c2ef73af13beccac2a4594220965d7))
* **node-agent:** copy the node-testkit manifest so the image builds ([9ce7afc](https://github.com/JinhuW/reddit_marketing/commit/9ce7afc9f45159f183b54a541fa6ae38cbabbfa1))
* **node-testkit:** wait for the reply before counting it in the fake CDP test ([8247e6b](https://github.com/JinhuW/reddit_marketing/commit/8247e6b88bb15ca6c2038be34cae3db6a07232d1))
* **ops:** node seccomp profile from Docker's default allowlist; root-owned bin; git under sudo ([4fe148f](https://github.com/JinhuW/reddit_marketing/commit/4fe148fbffd63bb50735eb086b5274fb79fe4ce4))
* **web:** allow server actions from the public domain behind the Railway host ([731962b](https://github.com/JinhuW/reddit_marketing/commit/731962b8da1b612e52c1b79891424478898fabb1))
* **web:** keep Playwright specs out of Vitest ([56c6918](https://github.com/JinhuW/reddit_marketing/commit/56c691841a32d3503b5e6fd10158e1c76892ffb7))
* **web:** run the custom server in production so /api/vnc upgrades work ([dd1ad8a](https://github.com/JinhuW/reddit_marketing/commit/dd1ad8aae971eb84f2e8dd7c35f069825fec13c3))
* **worker:** import scorePost from the runtime entry; lint fixes ([2eba791](https://github.com/JinhuW/reddit_marketing/commit/2eba7916008e817d26820328a266a381da160a19))
* **worker:** lint in post.publish test ([f36acfb](https://github.com/JinhuW/reddit_marketing/commit/f36acfb9079537c7221672bcfe32911204f48d96))

## Changelog

All notable changes to Threadline are recorded here. This file is generated by
[release-please](https://github.com/googleapis/release-please) from Conventional Commit messages on `main`;
do not edit released sections by hand. See [docs/RELEASING.md](docs/RELEASING.md).
