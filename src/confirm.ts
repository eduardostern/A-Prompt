/**
 * A yes/no question in the site's own style, in place of the browser's
 * confirm(). Esc, the backdrop and Cancel answer no; Enter answers yes.
 */
let dialog: HTMLDialogElement | undefined;

export function askConfirm(opts: { title: string; message: string; ok: string }): Promise<boolean> {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2></h2>
        <p></p>
        <div class="confirm-actions">
          <button value="no" class="confirm-cancel" type="submit">Cancel</button>
          <button value="yes" class="confirm-ok" type="submit"></button>
        </div>
      </form>`;
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog!.close('no');
    });
    document.body.append(dialog);
  }
  const d = dialog;
  d.querySelector('h2')!.textContent = opts.title;
  d.querySelector('p')!.textContent = opts.message;
  const ok = d.querySelector<HTMLButtonElement>('.confirm-ok')!;
  ok.textContent = opts.ok;
  d.returnValue = 'no';
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
    ok.focus();
  });
}
