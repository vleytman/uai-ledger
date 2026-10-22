// A menu item unmounts before a dialog opens; restore focus to its stable trigger.
let actionTrigger: HTMLElement | null = null;
export function rememberActionTrigger(trigger: HTMLElement | null) {
  actionTrigger = trigger;
}
export function takeActionTrigger() {
  const trigger = actionTrigger;
  actionTrigger = null;
  return trigger;
}
