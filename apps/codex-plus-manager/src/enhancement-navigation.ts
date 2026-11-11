export type ManagerNavigationIntent = {
  page: "settings" | "enhance";
};

export function managerNavigationDestination(intent: ManagerNavigationIntent): { route: ManagerNavigationIntent["page"] } {
  return { route: intent.page };
}
