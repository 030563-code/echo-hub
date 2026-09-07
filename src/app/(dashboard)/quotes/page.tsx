import { redirect } from 'next/navigation'

// The Quotes index lands on the board, which is the working entry point now
// that deals are shown by their real HubSpot stage rather than in a queue.
//
// Synchronous on purpose. Awaiting anything here lets the shell start
// streaming, and Next then answers with an in-stream client redirect instead
// of a 307: the url stays on /quotes and the board never arrives. The saved
// filters are applied by the board itself, without a second hop.
export default function QuotesIndex() {
  redirect('/quotes/board')
}
