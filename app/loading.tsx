export default function Loading() {
  return (
    <div className="flex flex-col gap-4 p-4 w-full h-full min-h-[50vh]">
      <div className="h-10 bm-skeleton w-48 rounded-lg mb-2"></div>
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-16 bm-skeleton w-full rounded-xl"></div>
        ))}
      </div>
    </div>
  );
}
