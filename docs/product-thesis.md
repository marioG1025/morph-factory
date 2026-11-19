# Will teams pay for a faster repair decision?

**Hypothesis.** An engineering lead or agency owner maintaining a small product will pay to shorten the time between a reproducible failure and a decision to keep or reject a patch. The first customer needs a Git repository, a check they trust and recent bugs that took human time to verify.

## What a visitor can verify

- **From failure to proposed repair.** On VibeCheck, a real signed-in model first declined a concert-date repair. A second request with both affected source files attached produced a four-line patch. Two of six calendar checks passed on the original commit and all six passed on the candidate. A fresh checkout reproduced the patch digest, Git tree and counts. [Two requests and exact diff](experiments/agent-proposal.md) · [Replay receipt](experiments/receipts/vibecheck-agent-calendar.json)
- **A review desk that updates in use.** Nikhil Ajay Kadalge’s Live Layer Protocol now powers Change review in the factory itself. While VibeCheck verification was in progress, two open tabs received the Compare control and kept their documents. The verification then returned a passing Vite build. The signatures cover the release and server rehearsal. The local check runner records product test outcomes. [Build experiment](experiments/concurrent-build.md) · [Integration and attribution](llp-integration.md)
- **Evidence a maintainer can share.** The factory opened a draft PR on its own repository with the tested commit, candidate tree and before/after counts. Two launcher checks changed from failing to passing. The VibeCheck experiments ended locally. [Factory draft PR](https://github.com/marioG1025/morph-factory/pull/1)

## What a buyer could use today

A second test exercised both calendar patches on VibeCheck’s rendered React screens in four time zones. Each candidate fixed 12 of 48 observations, and all 24 timestamp controls continued to pass. Those cases were written after the proposals existed. This supplies a reproducible example of checking an agent’s patch independently. [Product browser experiment](experiments/product-browser.md)

GitHub Copilot can investigate a repository, iterate on a branch and prepare a PR. A team can already review that diff with its usual CI. Sentry Seer starts from an observed issue, investigates its cause and can open a fix. PostHog Self-Driving investigates product signals and can turn actionable findings into PRs. Start a comparison with the workflow the team actually uses. [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/research-plan-iterate) · [Sentry Seer](https://docs.sentry.io/api/seer/start-seer-issue-fix/) · [PostHog Self-Driving](https://posthog.com/blog/self-driving-ga)

Morph’s offer is narrower. Bring an existing check, run it on the original and proposed trees, and inspect the same failure, diff and result before publishing. Research to date measures software behavior. Buyer demand, review-time savings and renewal remain open questions. [Original founder research](research.pdf)

## A 30-day paid pilot

1. Invite 20 qualified leads. Seek three teams willing to pay **$200 for one repository** and supply four recent reproducible issues each. Fewer than three payments triggers a review of the customer and offer.
2. Run each of the 12 issues through Morph and the team’s existing agent and CI workflow from the same commit. Give both the same failure, source access and time budget. Before either run, the maintainer records expected behavior and one additional case both builders will learn about only after proposing their patches.
3. Randomize review order and use independent reviewers where possible. Record setup, active review and rework minutes, all declined or abandoned cases, held-out results and model cost. Cap the active review budget at 45 minutes per issue on each side and count unfinished issues at the cap.
4. Proceed only if median paired review-and-rework time falls by at least **30%**, Morph resolves at least as many cases as the existing workflow, every accepted patch passes its held-out check, and at least **two teams pay $149 per repository** for a second month. These are proposed prices and decision thresholds. Three customers would warrant a larger trial.
