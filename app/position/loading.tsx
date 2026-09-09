export default function Loading() {
  return (
    <div className="p-4 flex flex-col gap-4 w-full">
      <div className="h-8 bm-skeleton w-32 rounded-lg"></div>
      <div className="flex justify-between items-center bg-gray-50 dark:bg-[#1e222d] p-4 rounded-xl">
        <div className="h-10 bm-skeleton w-24 rounded-lg"></div>
        <div className="h-10 bm-skeleton w-24 rounded-lg"></div>
      </div>
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-28 bm-skeleton w-full rounded-xl"></div>
        ))}
      </div>
    </div>
  );
}
