# Wanfang Research Integrity Training Userscript

[简体中文](README.md) | [English](README.en.md)

A Tampermonkey userscript for Wanfang's research integrity training platform, with playback assistance, lesson navigation, server record verification, quiz handling, and diagnostic exports.

**Current version: v1.6.0** · [Source](src/wf-auto-course.user.js) · [Report an issue](https://github.com/XiaobaiBye/wanfang-integrity-training/issues)

## Supported pages

The script supports course learning pages and the exam board on Wanfang's training platform while you are signed in:

```text
https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=...
https://cx.wanfangdata.com.cn/e-training/lecture/courselearn?courseId=...
https://cx.wanfangdata.com.cn/e-training/exam/examboard
```

It depends on the site's current Vue/Vuex structure and APIs, so platform changes may affect compatibility. No build step or local server is required. This English documentation does not translate the script's Chinese interface.

## Features

| Feature | Current behavior |
| --- | --- |
| Playback assistance | Muted playback at 1x by default, with start, pause, and stall recovery controls |
| Playback speed | Cycle through 1 / 1.25 / 1.5 / 1.75 / 2x, display the actual speed, and correct player resets |
| Lesson navigation | Skip completed entries and click the site's original directory; pause on ambiguous matches or navigation timeout |
| Learning record verification | Compare local duration with the server course tree and display server completion status |
| Additional playback | Try replaying from the beginning at 1x when the server has not confirmed completion and duration is missing; pause if records fail to grow sufficiently or verification fails |
| Lesson quizzes | Support probe-and-correct submissions and a manual mode |
| Exams | Exam board selection, starting, available-answer filling, answer import, and separate submission; automatic course exam submission stays disabled by default |
| AI answers | Use a configured OpenAI-compatible endpoint to generate suggestions and brief explanations; review, fill, and submit remain separate actions |
| Diagnostics | Export diagnostic JSON, text logs, and summaries; inspect state through console helpers |

Video position, locally accumulated duration, and a successful reporting response do not independently prove that progress was saved or that the server considers a lesson complete. The default behavior relies on server confirmation. Faster playback does not guarantee a reduction in the actual study time required by the platform.

## Installation and updates

1. Install and enable **Tampermonkey** in Chrome or Edge. Follow the extension's instructions to allow userscripts to run.
2. Open the [userscript installation link](https://raw.githubusercontent.com/XiaobaiBye/wanfang-integrity-training/main/src/wf-auto-course.user.js). If Tampermonkey opens its installer, select Install.
3. If the browser only shows source code, create a new script in Tampermonkey, remove the template, paste the entire source, and save.
4. Sign in to Wanfang and open a course learning page or the exam board. A v1.6.0 panel should appear in the upper-right corner.

To update, replace the installed script with the entire latest source, save, and reload the course page. The script currently has no `@updateURL` / `@downloadURL` metadata, so check versions and update manually. Avoid enabling multiple copies at once.

v1.6.0 adds Tampermonkey cross-origin requests, userscript storage, and page-context permissions. Accept the extension's permission prompts when updating. `@connect *` supports configurable provider domains; AI requests are sent only to the configured endpoint after clicking the solve button.

## Usage

### Exam board

Open the [exam board](https://cx.wanfangdata.com.cn/e-training/exam/examboard). A separate exam panel appears:

1. Select a paper and click **开始所选考试** (Start selected exam). This invokes the site's original requirement and start flow. The site's timer begins and can automatically submit at expiry.
2. Click **填写可用答案** (Fill available answers). Only questions with a supplied `rightAnswer` are filled. Missing answers remain for manual entry; the helper does not guess or submit a probe paper.
3. Use **导出题目** (Export questions) or import a JSON object such as `{"3260":"A,C","3261":"B"}`. Letters refer to original options. The helper converts them to this paper's randomized display order. Single choice, multiple choice, and true/false questions are supported.
4. Review the selected options, then click **提交已填写试卷** (Submit filled paper). Missing answers, invalid mappings, and duplicate clicks prevent helper submission. The site's own manual controls remain available.

Opening the page does not automatically start or submit an exam. The API may omit answers. This first implementation was checked against the public frontend and simulated tests; real account permissions, payloads, and results still need live verification. Export diagnostics when reporting problems; exports include question and answer content.

Console API: `__CX.examBoard.inspect()`, `.start(examId)`, `.fill()`, `.fill({questionId: 'A,C'})`, and `.submit()`. Starting begins the timer; submitting actually hands in the paper.

### AI answers

1. Expand **AI 解题设置** (AI settings) and enter a Chat Completions-compatible endpoint, model, and API key. Base URLs such as `https://provider/v1` and full `.../chat/completions` URLs are accepted. Use a model name supported by your provider.
2. Click **保存 AI 配置** (Save). Keys remain in the current script session by default. **记住密钥** explicitly stores the key in Tampermonkey storage; **清除密钥** removes it. Keys are excluded from site localStorage, configuration exports, and diagnostics.
3. Start the exam, optionally fill supplied answers, then click **AI 解题**. Only unanswered questions without supplied answers are sent: item IDs, types, question text, and options. Login cookies and full diagnostics are not sent. Provider fees may apply. Requests run sequentially in batches of up to five questions, with a 90-second timeout and no automatic retries. **停止 AI** cancels work.
4. Review the suggested display options and brief explanations, then click **填入 AI 建议**. Existing answers are preserved. Changing the exam or option order invalidates old suggestions. Invalid, duplicate, unknown, or uncertain answers remain for manual handling.
5. Check the full paper and submit separately. AI answers can be wrong. The site's original countdown and submission at expiry still apply.

Enable JSON mode only if the provider supports `response_format: {type: 'json_object'}`. Otherwise leave it off; the script still requests and validates JSON. The protocol follows the [OpenAI Chat Completions documentation](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create); individual provider/model compatibility requires a live test.

Console API: `__CX.ai.config()` (no key), `.configure({endpoint, model, apiKey, rememberKey: false, jsonMode: false})`, `.solve()`, `.cancel()`, `.apply()`, and `.clearKey()`. Enter keys in the panel rather than sharing them in issue reports.

### Course pages

The script starts automatically when a course page opens. On first use, you can select “暂停” (Pause), choose a lesson in the site's original directory, then select “开始” (Start).

| Panel item | Meaning |
| --- | --- |
| 开始 / 暂停 — Start / Pause | Control the assistant; pausing invalidates the current asynchronous playback task |
| 下一节 — Next | Manually request navigation to the next incomplete entry; this does not mark the current lesson complete |
| Speed button | Cycle through target speeds; additional playback is forced to 1x |
| 考试 — Exam | Attempt to load and submit the course's exam; clicking may actually submit a paper |
| 本地 / 服务端 / 差 — Local / Server / Gap | Local duration, the retrieved server duration, and the missing duration |
| Server status | Confirmed complete, not confirmed, no record, or not checked |
| 上报 X/Y — Reports | Observed successful `insertrecord` responses / requests; this is not a count of verified saved records |
| 诊断包 / 导出日志 / 复制摘要 | Export diagnostic JSON / export logs / copy a summary |

Normal playback waits for the video to end naturally, then allows time for settlement and verifies the record. With automatic navigation enabled, a server reconciliation that confirms completion may also advance the lesson during playback. By default, reaching the end locally does not authorize advancement. Additional playback is not considered complete merely because the displayed duration gap has elapsed.

## Configuration

Open the browser developer tools Console on a course page, inspect or edit `__CX.cfg`, and call `__CX.save()` to persist changes. Settings are stored in the site's browser `localStorage` under `cx_cfg_v2`.

For example, switch lesson quizzes to manual handling:

```js
__CX.pause();
__CX.cfg.quizStrategy = 'manual';
__CX.save();
__CX.resume();
```

| Setting | Default | Description |
| --- | --- | --- |
| `rate` | `1` | Target speed; `__CX.rate(1.5)` also applies and saves a speed |
| `rateGuard` | `true` | Maintain speed and try falling back to 1x when speed appears to affect completion |
| `mute` | `true` | Mute playback |
| `autoNext` | `true` | Advance after video completion is confirmed |
| `skipFinished` | `true` | Skip completed video entries |
| `autoQuiz` | `true` | Handle quiz entries automatically; disable for manual handling |
| `quizStrategy` | `'probe'` | Probe and correct automatically; `'manual'` pauses for user input |
| `autoExam` | `false` | Attempt an exam after all entries have been processed |
| `verify` | `true` | Verify server records; keeping this enabled is recommended |
| `topUp` | `true` | Try replaying at 1x if completion is unconfirmed and duration is missing |
| `settleWait` | `4000` | Settlement delay after video end, in milliseconds |
| `selfHeal` | `true` | Detect stalls and attempt recovery |
| `netLog` | `true` | Record network information for diagnostics |

Defaults also retain `completeRatio: 1`, `finishGap: 0`, `strictComplete: true`, and `verifyMode: 'strict'`. Some are legacy compatibility fields. The current video verification failure path pauses playback; changing these fields should not be relied on to enable permissive advancement.

`running` is not persisted; reloading starts the assistant again by default. Use `__CX.reset()` to restore and save default settings.

## Known limitations and troubleshooting

- **Directory navigation still needs live validation.** v1.4.7 prioritizes text or clickable elements inside a resource-bound container. Mock regression tests cover this behavior, but do not guarantee navigation works for every live course. If navigation fails, pause the assistant, select the lesson in the original directory, and resume.
- **Unexpected progress after navigation and HTTP 500 responses are not fixed in this version.** If the server fails or records stop growing, check the original page and network before resuming.
- **Automatic quiz handling may submit real answers.** The default `probe` mode submits a probe answer when answers are missing, then tries to retrieve answers and correct the submission. If answers remain unavailable, it may retain the probe result and continue. Correctness and server completion are not guaranteed. Use `manual` mode to answer questions yourself.
- **Exam answers may be absent.** The exam board fills only supplied or imported answers. Missing questions require manual handling; passing is not guaranteed. Course-linked exam handling still requires all answers from the API.
- **Background playback depends on the browser.** The background-pause workaround cannot eliminate timer throttling, system sleep, or network outages. Bring the course tab to the foreground when playback stalls.

When reporting an issue, include the script version, browser version, reproduction steps, and expected versus actual behavior. Share redacted diagnostics when useful. Diagnostic exports may include page URLs, course and resource identifiers, request contents, API responses, or question data; inspect and redact them before sharing.

## Console helpers

Run these on a course page where the script is loaded:

```js
__CX.version           // Current version
__CX.runtime()         // Task generation, context, and pending task status
await __CX.check()     // Request server reconciliation now
__CX.server()          // Inspect retrieved server course records
__CX.ledger()          // Compare local and server duration
__CX.rateInfo()        // Inspect target speed, actual speed, and guard events
await __CX.verify('3.4') // Force verification of a lesson code
await __CX.refresh()   // Refresh the server course tree
__CX.diag()            // Download full diagnostic JSON
__CX.dump()            // Return the full diagnostic object in the console
__CX.pause()           // Pause the assistant
__CX.resume()          // Resume the assistant
```

## Development and verification

```text
.
├── README.md                    # Chinese documentation
├── README.en.md                 # English documentation
├── src/
│   └── wf-auto-course.user.js    # Installable userscript
└── tests/
    ├── rate-harness.js          # Speed, panel, and duration-gap regression checks
    ├── lifecycle-harness.js     # Async lifecycle, navigation, and verification checks
    ├── exam-harness.js          # Exam start, shuffled options, filling, and submission checks
    └── ai-harness.js            # AI requests, key handling, cancellation, batches, and validation
```

With Node.js installed, run the following from the repository root. No npm dependencies are required:

```bash
node --check src/wf-auto-course.user.js
node tests/rate-harness.js
node tests/lifecycle-harness.js
node tests/exam-harness.js
node tests/ai-harness.js
```

The tests use mock DOM elements, Vue state, a player, and network responses to verify local control flow. Live compatibility, platform time accounting, and final completion status require online validation.

## Recent changes

| Version | Main changes |
| --- | --- |
| v1.4.7 | Prefer an actual entry inside a resource-bound container; record locator method and navigation outcome |
| v1.5.0 | Add exam board tools, native starting, shuffled option mapping, answer import, separate submission, and exam regression coverage |
| v1.6.0 | Add configurable AI requests, batched suggestions, preview and application, GM networking, and key storage management |
| v1.4.6 | Locate unnamed quizzes using resource bindings and neighboring lessons |
| v1.4.5 | Check pre-existing full progress only on lesson entry or resume to avoid interrupting the video ending |
| v1.4.4 | Allow automatic navigation during playback or replay when reconciliation confirms server completion |
| v1.4.3 | Skip completed quizzes, including entries without names, during navigation |
| v1.4.2 | Navigate through the original directory and check for reporting resource mismatches |
| v1.4.1 | Wait for natural video end and pause when verification does not confirm completion |
| v1.4.0 | Serialize playback tasks and isolate stale responses after pause, navigation, or course changes |

Earlier implementations and investigation notes are available in Git commit history.
