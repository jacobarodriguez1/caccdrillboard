export async function getServerSideProps() {
  return {
    redirect: {
      destination: "/public",
      permanent: false,
    },
  };
}

export default function Home() {
  return null;
}
