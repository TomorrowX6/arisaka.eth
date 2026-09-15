\\ Operator fixture construction only; normal builds use curve-fixtures.json.
default(datadir,".private/tools/pari/usr/share/pari");
default(parisizemax,256000000);
p=2^127-1; seen=List(); product=1; havebase=0;
{
for(b=3,500,
  E=ellinit([-3,b],p); n=ellcard(E);
  if(!havebase && isprime(n),
    x=1; while(#ellordinate(E,x)==0,x++); y=ellordinate(E,x)[1];
    print("BASE ",b," ",n," ",x," ",lift(y)); havebase=1;
  );
  f=factor(n,8192);
  for(i=1,matsize(f)[1],
    r=f[i,1]; if(r<257 || r>8192 || !isprime(r) || setsearch(Set(Vec(seen)),r),next);
    x=b*17+1;
    for(attempt=1,100,
      ys=ellordinate(E,x);
      if(#ys,
        P=ellmul(E,[Mod(x,p),ys[1]],n/r);
        if(#P==2,break);
      ); x++;
    );
    if(#P!=2,next);
    print("POINT ",b," ",n," ",r," ",lift(P[1])," ",lift(P[2]));
    listput(seen,r); product*=r;
    if(product>2^128,break);
  );
  if(havebase && product>2^128,break);
);
print("BITS ",log(product)/log(2));
}
quit;
