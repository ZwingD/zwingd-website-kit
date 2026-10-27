"use client";
// "You already have this course": the link opens THAT course in the app when the
// kit knows the app's course page (`coursePath`), else the member's learning
// page (kit #11). A plain link: the member is signed in to the app already.
import { useCourseUrl } from "@zwingd-ce/website-kit-next/client";

export function OwnedCourse(props: { courseCode: string | null; message: string }) {
  const courseUrl = useCourseUrl();
  return (
    <p role="status">
      {props.message} <a href={courseUrl(props.courseCode ?? "")}>Go to my course</a>
    </p>
  );
}
