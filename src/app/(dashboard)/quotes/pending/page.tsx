import { redirect } from 'next/navigation'

/**
 * /quotes/pending is gone. Dean: the pending status "does not exist in hubspot
 * anymore and must switch over to have the correct deal stages straight from
 * hubspot such as tender etc. to avoid confusion". The page defined Pending as
 * everything that was not one of six stage families and then labelled the lot
 * with one grey badge, so a Tender deal and a General pricing deal read the
 * same.
 *
 * Kept as a redirect rather than deleted, the same idiom as quotes/requests:
 * reps bookmark these.
 */
export default function PendingRedirect() {
  redirect('/quotes/board')
}
