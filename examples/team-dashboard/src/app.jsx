const TONES = { "On track": "success", "At risk": "warning", Blocked: "danger" };

export default function TeamDashboard() {
  const state = useAppState();
  const tasks = state.tasks ?? [];
  const open = tasks.filter((task) => !task.done);
  const status = state.status ?? "On track";
  return (
    <Page title="Team dashboard" width="wide">
      <Metrics
        metrics={[
          { label: "Open tasks", value: String(open.length) },
          { label: "Done", value: String(tasks.length - open.length) },
          { label: "Shipped", value: String(state.shipped ?? 0) },
        ]}
      />
      <Section heading="Status" actions={<Status tone={TONES[status]}>{status}</Status>}>
        <div className="rk-actions">
          <ActionButton action="setStatus" input={{ status: "On track" }} label="On track" />
          <ActionButton action="setStatus" input={{ status: "At risk" }} label="At risk" />
          <ActionButton action="setStatus" input={{ status: "Blocked" }} label="Blocked" />
          <ActionButton action="recordShipped" label="Shipped one" variant="primary" />
        </div>
      </Section>
      <Section heading="Tasks">
        <ActionForm action="addTask" label="Add task" />
        <Table
          columns={["Task", "Owner", "State", ""]}
          rows={tasks.map((task) => [
            task.title,
            task.owner ?? "",
            <Status key="state" tone={task.done ? "success" : "info"}>
              {task.done ? "Done" : "Open"}
            </Status>,
            <div key="actions" className="rk-actions">
              <ActionButton
                action="toggleTask"
                input={{ id: task.id }}
                label={task.done ? "Reopen" : "Done"}
              />
              <ActionButton action="removeTask" input={{ id: task.id }} label="Remove" />
            </div>,
          ])}
        />
      </Section>
    </Page>
  );
}
