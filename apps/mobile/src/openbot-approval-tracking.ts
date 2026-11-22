import type { OpenBotAdapter } from "../../../packages/backends/src/openbot";

type Approvals = Awaited<ReturnType<OpenBotAdapter["listUnsettledApprovals"]>>;
type ApprovalStatus = "pending" | "continuing" | "clear";

export function trackOpenBotApprovals() {
  const observed = new Set<string>();
  return async (
    requests: Approvals,
    refreshConversation: () => Promise<boolean>,
    report: (status: ApprovalStatus) => void,
  ) => {
    const current = new Set(requests.map(({ id }) => id));
    for (const id of current) observed.add(id);
    const settled = [...observed].filter((id) => !current.has(id));
    const pending = requests.some(({ status }) => status === "pending");
    const reportCurrent = () =>
      report(pending ? "pending" : observed.size ? "continuing" : "clear");

    reportCurrent();
    if (settled.length && (await refreshConversation())) {
      for (const id of settled) observed.delete(id);
      reportCurrent();
    }
  };
}
