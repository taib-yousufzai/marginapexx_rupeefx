export default function Loading() {
  return (
    <div className="p-4 flex flex-col gap-6 w-full">
      <div className="h-8 bm-skeleton w-24 rounded-lg"></div>
      <div className="h-40 bm-skeleton w-full rounded-2xl"></div>
      <div className="h-6 bm-skeleton w-32 rounded-lg"></div>
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-16 bm-skeleton w-full rounded-xl"></div>
        ))}
      </div>
    </div>
  );
}
