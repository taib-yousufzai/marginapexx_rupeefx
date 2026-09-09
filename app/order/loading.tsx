export default function Loading() {
  return (
    <div className="p-4 flex flex-col gap-4 w-full">
      <div className="h-8 bm-skeleton w-24 rounded-lg"></div>
      <div className="flex flex-col gap-3 mt-2">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 bm-skeleton w-full rounded-xl"></div>
        ))}
      </div>
    </div>
  );
}
