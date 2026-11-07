import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="m-0 text-lg font-semibold">Page not found</h1>
        <Link href="/" className="btn">
          Go home
        </Link>
      </div>
    </main>
  );
}
