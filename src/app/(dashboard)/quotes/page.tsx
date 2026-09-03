import { redirect } from 'next/navigation'

// The Quotes index lands on the board, which is the working entry point now
// that deals are shown by their real HubSpot stage rather than in a queue.
export default function QuotesIndex() {
  redirect('/quotes/board')
}
