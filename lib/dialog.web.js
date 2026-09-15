// Web twin of lib/dialog.js. window.confirm has only OK / Cancel, so the button
// labels are dropped — callers must phrase the title as the question.
const join = (title, message) => [title, message].filter(Boolean).join('\n\n');

export function notify(title, message) {
  window.alert(join(title, message));
}

export function confirm({ title, message }) {
  return Promise.resolve(window.confirm(join(title, message)));
}
