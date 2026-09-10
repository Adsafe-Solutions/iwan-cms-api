/* Work the response does not depend on — a mail send, a contact pushed to
   Resend — started here rather than by each route inventing its own pattern.

   ⚠ THIS EXISTS BECAUSE FIRE-AND-FORGET DOES NOT WORK ON VERCEL. A serverless
   function is frozen the moment its response is sent, so a promise nobody is
   waiting on is abandoned part-way: the sign-up is stored, the 201 goes out,
   and the confirmation email is simply never sent. Nothing errors and nothing
   is logged, which is what makes it so hard to see.
   https://github.com/vercel/vercel/discussions/4949

   On a normal always-on server (Render) the same promise finishes perfectly
   well after the response, and waiting for it would only make every form
   slower. So the two hosts genuinely differ, and this is the one place that
   difference is expressed — the same way storage.js already branches on VERCEL
   for the upload limit.

   ⚠ ALWAYS AWAIT THE RESULT, and always BEFORE sending the response. On Render
   it resolves immediately and costs a tick; on Vercel it is the only thing
   keeping the function alive long enough for the work to happen. */

const ON_VERCEL = Boolean(process.env.VERCEL);

/**
 * Runs `work`, and waits for it only where waiting is what makes it happen.
 *
 * ⚠ NEVER REJECTS. A failed notification is not a failed form, and an
 * unhandled rejection would take the process down on Node.
 *
 * @param {string} label what to call this in the log when it fails
 * @param {() => Promise<unknown>} work
 */
export function background(label, work) {
  const running = Promise.resolve()
    .then(work)
    .catch((err) => {
      console.error(`[background] ${label} failed:`, err?.message ?? err);
    });

  /* ⚠ The whole point. Off Vercel the caller carries on immediately and the
     work finishes on its own; on Vercel the caller waits, because there is no
     "on its own" after the response. */
  return ON_VERCEL ? running : Promise.resolve();
}

export default background;
